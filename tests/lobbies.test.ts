import { describe, expect, it } from 'vitest';
import { RaceSim } from '../src/sim/race';
import { sampleTrack } from '../src/sim/track';
import { badLog, lobbyVerdict, rank, replayRun, soloConfig, split, submittedInTime, SETTLE_AFTER_MS } from '../src/game/lobbies';

/** Drive a solo run the way the browser does (inputs set live, logged by the sim), with a simple line-follower. */
function driveRun(seed: string, aggression = 0.85) {
  const sim = new RaceSim(null, soloConfig(seed));
  const track = sim.track;
  while (!sim.done) {
    const c = sim.carStates()[0];
    const p = sampleTrack(track, c.progress + 18);
    let a = Math.atan2(p.y - c.y, p.x - c.x) - c.h;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    const steer = Math.max(-1, Math.min(1, a * 2.2));
    sim.setHumanInput(0, { throttle: Math.abs(a) > 0.35 ? 0.4 : aggression, steer, brake: Math.abs(a) > 0.6 ? 0.6 : 0 });
    sim.stepTick();
  }
  return { log: sim.inputLog.map((e) => [...e] as typeof e), result: sim.results()[0] };
}

describe('ghost lobbies', () => {
  it('re-simulating a run from its inputs gives exactly the same result', () => {
    const { log, result } = driveRun('lobby-test-1');
    expect(result.finished).toBe(true);
    expect(badLog(log)).toBeNull();
    const r = replayRun('lobby-test-1', log);
    expect(r.finished).toBe(true);
    expect(r.finishTime).toBe(result.finishTime);
    expect(r.progress).toBe(result.progress);
  });

  it('a log replayed on another track does not keep its time', () => {
    const { log, result } = driveRun('lobby-test-2');
    const r = replayRun('lobby-test-3', log);
    expect(r.finished && r.finishTime === result.finishTime).toBe(false);
  });

  it('rejects malformed logs', () => {
    expect(badLog('x')).toBeTruthy();
    expect(badLog([[0, 1, 1, 0, 0]])).toBeTruthy(); // another car
    expect(badLog([[5, 0, 1, 0, 0], [3, 0, 1, 0, 0]])).toBeTruthy(); // ticks going back
    expect(badLog([[0, 0, 1.5, 0, 0]])).toBeTruthy(); // out of range
    expect(badLog([[0, 0, 0.123, 0, 0]])).toBeTruthy(); // not quantized like the sim
    expect(badLog([[0, 0, 1, -0.5, 0]])).toBeNull();
  });

  it('a run must be submitted about as fast as it was driven', () => {
    const run = { finished: true, finishTime: 60, progress: 1000, crashed: false, endTick: 3600 };
    expect(submittedInTime(0, 80_000, run)).toBe('ok');
    expect(submittedInTime(0, 200_000, run)).toBe('late'); // had time for several attempts
    expect(submittedInTime(0, 5_000, run)).toBe('early'); // a 60 s lap back after 5 s: computed, not driven
  });

  it('first across the line wins; then the furthest along', () => {
    const order = rank([
      { uid: 'a', finished: false, finishTime: null, progress: 900, started: 1 },
      { uid: 'b', finished: true, finishTime: 64.2, progress: 1200, started: 2 },
      { uid: 'c', finished: true, finishTime: 61.9, progress: 1200, started: 3 },
      { uid: 'd', finished: false, finishTime: null, progress: 1100, started: 4 },
    ]);
    expect(order.map((s) => s.uid)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('settles at 5, or at 4 after 30 minutes; refunds at 3 or fewer', () => {
    const done = (n: number) => Array.from({ length: n }, () => ({ done: true }));
    expect(lobbyVerdict(0, 1000, done(5))).toBe('settle');
    expect(lobbyVerdict(0, 1000, [...done(4), { done: false }])).toBe('wait');
    expect(lobbyVerdict(0, 1000, done(4))).toBe('wait');
    expect(lobbyVerdict(0, SETTLE_AFTER_MS + 1, done(4))).toBe('settle');
    expect(lobbyVerdict(0, SETTLE_AFTER_MS + 1, done(3))).toBe('refund');
    expect(lobbyVerdict(0, SETTLE_AFTER_MS + 1, [...done(3), { done: false }])).toBe('wait'); // someone still driving
  });

  it('splits the pot 80 / 15 / 5', () => {
    expect(split(5, 20)).toEqual({ pot: 100, prize: 80, burn: 15, team: 5 });
    expect(split(4, 20)).toEqual({ pot: 80, prize: 64, burn: 12, team: 4 });
  });
});
