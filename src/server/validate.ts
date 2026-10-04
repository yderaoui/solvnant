// Smoke-test driver code before it's allowed to race.
import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import { runRace } from '../sim/race';
import { SANDBOX_LIMITS } from '../sim/sandbox';
import { HOUSE_BOTS, fallbackDriverCode } from '../sim/fallbackDriver';

export function validateDriver(qjs: QuickJSWASMModule, code: string): { ok: true } | { ok: false; error: string } {
  if (new TextEncoder().encode(code).length > SANDBOX_LIMITS.codeBytes) return { ok: false, error: 'code too large' };
  // Two short test races on fixed tracks: must not crash and must actually make progress.
  for (const seed of ['validation-a', 'validation-b']) {
    const rec = runRace(qjs, {
      seed,
      maxTime: 35,
      entries: [
        { name: 'candidate', model: 'candidate', color: '#fff', code, source: 'llm' },
        { name: 'house', model: 'house', color: '#000', code: fallbackDriverCode(HOUSE_BOTS[0].params), source: 'house' },
      ],
    });
    const r = rec.results.find((x) => x.car === 0)!;
    if (r.crashed) return { ok: false, error: `crashed on test track: ${r.crashReason}` };
    // Slow drivers are allowed to race (and lose); only reject cars that basically don't move.
    if (r.progress < 60) return { ok: false, error: `car barely moved on test track (${Math.round(r.progress)} m in 35 s)` };
  }
  return { ok: true };
}
