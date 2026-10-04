import { describe, expect, it } from 'vitest';
import { generateTrack, TRACK_RULES } from '../src/sim/track';
import { simulateRace, type Entry } from '../src/sim/race';
import { CAR_COLORS, HOUSE_BOTS, fallbackDriverCode } from '../src/sim/fallbackDriver';
import { DriverSandbox, loadQuickJS, SANDBOX_LIMITS } from '../src/sim/sandbox';
import { atan2, cos, sin } from '../src/sim/dmath';

function house(n: number): Entry[] {
  return HOUSE_BOTS.slice(0, n).map((b, i) => ({
    name: b.name,
    model: b.name,
    color: CAR_COLORS[i],
    code: fallbackDriverCode(b.params),
    source: 'house' as const,
  }));
}

function hashFrames(f: Float32Array): number {
  const u = new Uint32Array(f.buffer, f.byteOffset, f.length);
  let h = 2166136261;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
  return h >>> 0;
}

describe('dmath', () => {
  it('matches Math to high precision', () => {
    for (let x = -20; x < 20; x += 0.137) {
      expect(Math.abs(sin(x) - Math.sin(x))).toBeLessThan(1e-9);
      expect(Math.abs(cos(x) - Math.cos(x))).toBeLessThan(1e-9);
      expect(Math.abs(atan2(x, 3.3 - x) - Math.atan2(x, 3.3 - x))).toBeLessThan(1e-9);
    }
  });
});

describe('track generator', () => {
  it('same seed -> same track', () => {
    expect(JSON.stringify(generateTrack('hello'))).toBe(JSON.stringify(generateTrack('hello')));
    expect(JSON.stringify(generateTrack('hello'))).not.toBe(JSON.stringify(generateTrack('world')));
  });

  it('enforces width, length, clearance and corner rules', () => {
    for (let i = 0; i < 40; i++) {
      const t = generateTrack('seed-' + i);
      expect(Math.min(...t.widths)).toBeGreaterThanOrEqual(TRACK_RULES.minWidth);
      expect(t.length).toBeGreaterThanOrEqual(TRACK_RULES.minLength);
      expect(t.corners.length).toBeGreaterThanOrEqual(4);
      const N = t.points.length;
      const skip = Math.ceil(70 / t.spacing);
      for (let a = 0; a < N; a += 2)
        for (let b = a + skip; b < N; b += 2) {
          if (N - (b - a) < skip) continue;
          const d = Math.sqrt((t.points[a][0] - t.points[b][0]) ** 2 + (t.points[a][1] - t.points[b][1]) ** 2);
          expect(d).toBeGreaterThan((t.widths[a] + t.widths[b]) / 2);
        }
    }
  });
});

describe('race simulation', () => {
  it('replays identically for the same seed + drivers', async () => {
    const cfg = { seed: 'determinism', entries: house(6), maxTime: 60 };
    const a = await simulateRace(cfg);
    const b = await simulateRace(cfg);
    expect(a.frameCount).toBeGreaterThan(100);
    expect(hashFrames(a.frames)).toBe(hashFrames(b.frames));
    expect(a.results).toEqual(b.results);
    expect(a.events).toEqual(b.events);
  });

  it('a crashing driver stops but the race continues', async () => {
    const entries = house(3);
    entries[1] = { ...entries[1], code: 'function drive(s){ if (s.t > 5) throw new Error("boom"); return {throttle:1,steer:0,brake:0}; }' };
    entries[2] = { ...entries[2], code: 'function drive(s){ while(true){} }' };
    const rec = await simulateRace({ seed: 'crashy', entries, maxTime: 30 });
    const byCar = Object.fromEntries(rec.results.map((r) => [r.car, r]));
    expect(byCar[1].crashed).toBe(true);
    expect(byCar[1].crashReason).toContain('boom');
    expect(byCar[2].crashed).toBe(true);
    expect(byCar[2].crashReason).toContain('Timeout');
    expect(byCar[0].crashed).toBe(false);
    expect(byCar[0].progress).toBeGreaterThan(500);
  });
});

describe('sandbox', () => {
  const track = JSON.stringify({ points: [[0, 0]], spacing: 8 });

  it('has no network, DOM, timers or host access', async () => {
    const box = new DriverSandbox(await loadQuickJS(), 1);
    const code = `function drive(){ return { throttle: window === globalThis && [typeof fetch, typeof document, typeof setTimeout, typeof require, typeof process, typeof XMLHttpRequest, typeof WebSocket].every(t => t === 'undefined') ? 1 : 0, steer: 0, brake: 0 }; }`;
    expect(box.load(code, track).ok).toBe(true);
    expect(box.call('{"t":0}')!.throttle).toBe(1);
    box.dispose();
  });

  it('Math.random is seeded and Date is the race clock', async () => {
    const qjs = await loadQuickJS();
    const run = () => {
      const box = new DriverSandbox(qjs, 42);
      box.load('function drive(s){ return { throttle: Math.random(), steer: Date.now(), brake: 0 }; }', track);
      const out = box.call('{"t":3.5}')!;
      box.dispose();
      return out;
    };
    const a = run(),
      b = run();
    expect(a.throttle).toBe(b.throttle);
    expect(a.steer).toBe(3500);
  });

  it('rejects oversized code and runaway memory', async () => {
    const qjs = await loadQuickJS();
    const big = new DriverSandbox(qjs, 1);
    expect(big.load('// ' + 'x'.repeat(SANDBOX_LIMITS.codeBytes), track).ok).toBe(false);
    big.dispose();
    const hog = new DriverSandbox(qjs, 1);
    hog.load('const a=[]; function drive(){ for(let i=0;i<1e5;i++) a.push(new Array(1000).fill(i)); return {throttle:1,steer:0,brake:0}; }', track);
    expect(hog.call('{"t":0}')).toBeNull();
    expect(hog.dead).toBe(true);
    hog.dispose();
  });

  it('rejects code without drive()', async () => {
    const box = new DriverSandbox(await loadQuickJS(), 1);
    const r = box.load('function steer(){}', track);
    expect(r.ok).toBe(false);
    box.dispose();
  });
});
