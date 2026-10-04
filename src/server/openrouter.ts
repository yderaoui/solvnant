// OpenRouter: discover free models and ask them to write a driver.
import { DRIVER_SPEC } from '../sim/driverApi';
import type { Track } from '../sim/track';

const API = 'https://openrouter.ai/api/v1';

export interface ModelInfo {
  id: string;
  name: string; // short display name
}

/** All currently free text models on OpenRouter. */
export async function listFreeModels(): Promise<ModelInfo[]> {
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error(`OpenRouter /models: ${res.status}`);
  const { data } = (await res.json()) as { data: any[] };
  return data
    .filter((m) => {
      // Only ':free' ids: other $0-priced models can still be billed (and fail on a $0-limit key).
      const free = m.id.endsWith(':free');
      const textOut = !m.architecture?.output_modalities || m.architecture.output_modalities.includes('text');
      return free && textOut && (m.context_length ?? 0) >= 16000;
    })
    .map((m) => ({ id: m.id, name: shortName(m.name ?? m.id) }));
}

export function shortName(name: string): string {
  let n = name.replace(/\(free\)/i, '').trim();
  if (n.includes(': ')) n = n.split(': ').slice(1).join(': ');
  return n.length > 24 ? n.slice(0, 23) + '…' : n;
}

/**
 * Pick up to `max` models, one per vendor where possible so the grid is varied.
 * `preferred` (from env) are taken first, in order.
 */
export function pickModels(all: ModelInfo[], preferred: string[], max: number, exclude: Set<string> = new Set()): ModelInfo[] {
  const free = all.filter((m) => !exclude.has(m.id));
  const byId = new Map(free.map((m) => [m.id, m]));
  const out: ModelInfo[] = [];
  for (const id of preferred) {
    const m = byId.get(id) ?? (id.includes('/') ? { id, name: shortName(id.split('/')[1]) } : null);
    if (m && !out.some((o) => o.id === m.id)) out.push(m);
  }
  const vendors = new Set(out.map((m) => m.id.split('/')[0]));
  for (const m of free) {
    if (out.length >= max) break;
    const v = m.id.split('/')[0];
    if (vendors.has(v)) continue;
    vendors.add(v);
    out.push(m);
  }
  for (const m of free) {
    if (out.length >= max) break;
    if (!out.some((o) => o.id === m.id)) out.push(m);
  }
  return out.slice(0, max);
}

function trackSummary(track: Track, laps: number): string {
  const pts = track.points
    .filter((_, i) => i % 3 === 0)
    .map((p, k) => [Math.round(p[0]), Math.round(p[1]), Math.round(track.widths[k * 3])]);
  return JSON.stringify({
    length: Math.round(track.length),
    laps,
    spacing: Number(track.spacing.toFixed(2)),
    corners: track.corners,
    centerline_every_3rd_point_x_y_width: pts,
  });
}

export function buildPrompt(track: Track, laps: number) {
  const system =
    'You are an expert racing-game AI programmer. You write compact, fast, robust JavaScript. ' +
    'You only reply with a single ```javascript code block.';
  const user = `${DRIVER_SPEC}

## Example of the shape (deliberately naive, you should do much better)
\`\`\`javascript
function drive(state) {
  const me = state.me;
  return { throttle: me.speed < 25 ? 1 : 0, steer: me.headingError * 2, brake: 0 };
}
\`\`\`

## The track for the next race
Your code will also be reused on other random tracks, so it must read TRACK at runtime.
${trackSummary(track, laps)}

Write the best driver you can: plan braking for upcoming corners using TRACK.curvature, take a good racing line,
avoid other cars and overtake when it's safe, and recover if you go off track. You are racing against other AI models.
Reply with ONLY one \`\`\`javascript code block containing the complete code.`;
  return { system, user };
}

/** Pull the driver code out of a model reply. */
export function extractCode(text: string): string | null {
  const blocks = [...text.matchAll(/```[ \t]*(?:javascript|js|typescript|ts)?[ \t]*\r?\n([\s\S]*?)```/gi)].map((m) => m[1]);
  let code =
    blocks.filter((b) => /function\s+drive\s*\(|\bdrive\s*=/.test(b)).sort((a, b) => b.length - a.length)[0] ??
    (/function\s+drive\s*\(/.test(text) ? text : null);
  if (!code) return null;
  code = code
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+/gm, '')
    .replace(/^\s*module\.exports\s*=.*$/gm, '')
    .trim();
  return code;
}

export class RateLimitError extends Error {}

export async function generateDriverCode(
  apiKey: string,
  model: string,
  track: Track,
  laps: number,
): Promise<{ code: string | null; raw: string; finishReason: string | null }> {
  const { system, user } = buildPrompt(track, laps);
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.SITE_URL || 'https://github.com/',
      'X-Title': 'AI Grand Prix',
    },
    body: JSON.stringify({
      model,
      temperature: 0.6,
      max_tokens: 16000,
      // Reasoning models otherwise spend the whole budget thinking and never write the code.
      reasoning: { effort: 'low' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (res.status === 429) throw new RateLimitError(`rate limited (${model})`);
  const body = (await res.json().catch(() => null)) as any;
  if (!body) throw new Error(`empty or cut-off response from OpenRouter (HTTP ${res.status}, likely an upstream timeout)`);
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
  if (body.error) throw new Error(`OpenRouter error: ${JSON.stringify(body.error).slice(0, 300)}`);
  const choice = body.choices?.[0];
  const raw: string = choice?.message?.content || '';
  // Some models put the final answer only in the reasoning text.
  const code = extractCode(raw) ?? extractCode(choice?.message?.reasoning || '');
  return { code, raw, finishReason: choice?.finish_reason ?? null };
}
