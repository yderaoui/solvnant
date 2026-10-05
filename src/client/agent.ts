// "Bring your own agent": write a drive(state) function, check it in the browser (the same sandbox
// smoke test the scheduler runs), practise against the house bots, then submit it to the AI League.
import { account, showAuthModal } from './account';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { toast } from './toast';
import { DRIVER_SPEC } from '../sim/driverApi';
import { CAR_COLORS, HOUSE_BOTS, fallbackDriverCode } from '../sim/fallbackDriver';
import type { EntryInfo } from './data';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DRAFT = 'tl-agent-draft';

interface Draft {
  name: string;
  code: string;
}

interface Submission {
  id: number;
  name: string;
  status: 'pending' | 'valid' | 'rejected';
  error: string | null;
  created_at: string;
  model: string;
}

const starter = () => `// Your agent starts as a copy of a house bot. Make it faster!\n// Docs: see "Driver API" on the right.\n${fallbackDriverCode(HOUSE_BOTS[0].params).replace(/^\/\/ Fallback driver:.*\n/, '')}`;

export function loadDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT) ?? 'null') as Draft | null;
    if (d?.code) return d;
  } catch {
    /* fall through */
  }
  return { name: '', code: starter() };
}

function saveDraft(d: Draft) {
  try {
    localStorage.setItem(DRAFT, JSON.stringify(d));
  } catch {
    /* private mode */
  }
}

/** Grid for a practice race: your agent against the house bots. */
export function practiceEntries(d: Draft): EntryInfo[] {
  const you: EntryInfo = { name: d.name || 'Your agent', model: 'agent:you', color: CAR_COLORS[0], code: d.code, source: 'agent' };
  return [
    you,
    ...HOUSE_BOTS.slice(0, 5).map((b, i) => ({
      name: b.name.replace('House Bot ', 'Bot '),
      model: b.name,
      color: CAR_COLORS[i + 1],
      code: fallbackDriverCode(b.params),
      source: 'house' as const,
    })),
  ];
}

let wired = false;

export function renderAgentPage() {
  const d = loadDraft();
  const el = $('agent-body');
  if (!wired) {
    wired = true;
    account.onChange(() => {
      if (document.body.dataset.page === 'agent') void loadSubmissions();
    });
  }
  el.innerHTML = `
    <div class="agent-grid">
      <section class="agent-editor">
        <div class="agent-row">
          <label class="agent-name"><span>Agent name</span><input id="ag-name" maxlength="16" spellcheck="false" placeholder="e.g. ApexHunter" value="${escapeHtml(d.name)}" /></label>
          <button class="btn small btn-ghost" id="ag-reset" title="Replace your code with the starter bot">${icon('replay', 14)}Starter code</button>
        </div>
        <textarea id="ag-code" class="code-input" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Driver code">${escapeHtml(d.code)}</textarea>
        <div class="agent-row">
          <span id="ag-size" class="muted small"></span>
          <span class="grow"></span>
          <button class="btn" id="ag-check">${icon('check', 16)}Check code</button>
          <button class="btn" id="ag-test">${icon('play', 16)}Practice race</button>
          <button class="btn btn-lime" id="ag-submit">SUBMIT TO AI LEAGUE</button>
        </div>
        <p id="ag-msg" class="agent-msg" role="status"></p>
      </section>
      <aside class="agent-side">
        <section class="lcard">
          <h3>YOUR SUBMISSIONS</h3>
          <ol id="ag-list" class="agent-list"><li class="muted">Loading…</li></ol>
          <p class="muted small">Valid agents take turns in a few seats of every AI League race and show up on the leaderboard as <code>agent:@you/name</code>. Your newest valid agent is the one that races.</p>
        </section>
        <details class="lcard agent-spec" open>
          <summary><h3>DRIVER API</h3></summary>
          <pre class="code"><code>${escapeHtml(DRIVER_SPEC)}</code></pre>
        </details>
      </aside>
    </div>`;
  const name = $<HTMLInputElement>('ag-name');
  const code = $<HTMLTextAreaElement>('ag-code');
  const draft = () => ({ name: name.value.trim(), code: code.value });
  const size = () => {
    const kb = new TextEncoder().encode(code.value).length / 1000;
    $('ag-size').textContent = `${code.value.split('\n').length} lines · ${kb.toFixed(1)} / 20 KB`;
    $('ag-size').classList.toggle('down', kb > 20);
  };
  size();
  name.oninput = code.oninput = () => {
    saveDraft(draft());
    size();
  };
  // Tab inserts two spaces instead of leaving the editor (Esc then Tab still moves focus on).
  let escaped = false;
  code.onkeydown = (e) => {
    if (e.key === 'Escape') escaped = true;
    else if (e.key === 'Tab' && !e.shiftKey && !escaped) {
      e.preventDefault();
      const s = code.selectionStart;
      code.setRangeText('  ', s, code.selectionEnd, 'end');
      saveDraft(draft());
    } else escaped = false;
  };
  $('ag-reset').onclick = () => {
    if (!confirm('Replace your code with the starter bot?')) return;
    code.value = starter();
    saveDraft(draft());
    size();
  };
  $('ag-check').onclick = () => void check(draft().code);
  $('ag-test').onclick = () => {
    saveDraft(draft());
    location.hash = '#/replay/practice';
  };
  $('ag-submit').onclick = () => void submit(draft());
  void loadSubmissions();
}

function msg(html: string, kind: 'ok' | 'err' | '' = '') {
  const m = $('ag-msg');
  m.className = `agent-msg ${kind}`;
  m.innerHTML = html;
}

/** The scheduler's smoke test (two short races on fixed tracks), run right here. */
async function check(code: string): Promise<boolean> {
  msg('Checking: two short test races in the sandbox…');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const [{ validateDriver }, { loadQuickJS }] = await Promise.all([import('../sim/validate'), import('../sim/quickjs')]);
    const v = validateDriver(await loadQuickJS(), code);
    if (v.ok) msg(`${icon('check', 14)}Looks good: it finished the test laps without crashing.`, 'ok');
    else msg(`${icon('alert', 14)}Not ready: ${escapeHtml(v.error)}`, 'err');
    return v.ok;
  } catch (e) {
    msg(`${icon('alert', 14)}${escapeHtml((e as Error).message)}`, 'err');
    return false;
  }
}

async function submit(d: Draft) {
  if (!account.me) return showAuthModal();
  if (!d.name) {
    msg('Give your agent a name first.', 'err');
    $('ag-name').focus();
    return;
  }
  if (!(await check(d.code))) return;
  try {
    await account.api('/api/agents', { name: d.name, code: d.code });
    msg(`${icon('check', 14)}Submitted. The scheduler checks it again and puts it on the grid of upcoming races (usually within 30 minutes).`, 'ok');
    toast('Agent submitted');
    void loadSubmissions();
  } catch (e) {
    msg(`${icon('alert', 14)}${escapeHtml((e as Error).message)}`, 'err');
  }
}

async function loadSubmissions() {
  const list = document.getElementById('ag-list');
  if (!list) return;
  if (!account.me) {
    list.innerHTML = `<li class="muted">Sign in to submit agents. You can check and practise without an account.</li>`;
    return;
  }
  try {
    const r = await account.api<{ enabled: boolean; agents: Submission[] }>('/api/agents');
    if (!r.enabled) {
      list.innerHTML = '<li class="muted">The AI League database isn’t set up on this server, so agents can’t be entered yet. Practice races still work.</li>';
      return;
    }
    list.innerHTML = r.agents.length
      ? r.agents
          .map(
            (a) => `<li><span class="st st-${a.status}">${a.status === 'valid' ? 'racing' : a.status}</span><b>${escapeHtml(a.name)}</b>
              <small>${new Date(a.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${a.error ? ` · ${escapeHtml(a.error)}` : ''}</small></li>`,
          )
          .join('')
      : '<li class="muted">Nothing submitted yet.</li>';
  } catch (e) {
    list.innerHTML = `<li class="muted">${escapeHtml((e as Error).message)}</li>`;
  }
}
