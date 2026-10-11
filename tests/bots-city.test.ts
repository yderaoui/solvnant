import { describe, expect, it } from 'vitest';
import { RaceSim, type Entry } from '../src/sim/race';
import { liveSimEntries } from '../src/game/liveEntries';
import { generateTrack, BOT_RACE_LAPS, TRACK_RULES } from '../src/sim/track';
import { fallbackDriverCode, HOUSE_BOTS } from '../src/sim/fallbackDriver';
import { simulateRace } from '../src/sim/quickjs';
const entries = liveSimEntries(Array.from({ length: 6 }, (_, i) => ({ name: `Bot ${i}`, color: '#ff006e', kind: 'bot' as const, bot: i })));
function race(seed: string, laps = 2, simVersion = '4') {
  const sim = new RaceSim(null, { seed, entries, laps, maxTime: laps * 115, obstacles: true, simVersion });
  try { while (!sim.done) sim.step(600); return sim.record(); } finally { sim.dispose(); }
}
describe('city circuit and improved race bots', () => {
  it('has a deterministic, wide, separated city course with safe bend radii', () => {
    const track = generateTrack('tokyo:test');
    expect(track).toEqual(generateTrack('tokyo:test'));
    expect(track.length).toBeGreaterThan(1300);
    expect(track.length).toBeLessThan(3200);
    expect(Math.min(...track.widths)).toBe(20);
    expect(Math.max(...track.curvature.map(Math.abs))).toBeLessThan(1 / TRACK_RULES.minRadius);
    const skip = Math.ceil(70 / track.spacing);
    track.points.forEach((p, i) => {
      for (let j = i + skip; j < track.points.length; j++) {
        if (track.points.length - (j - i) < skip) continue;
        expect(Math.hypot(p[0] - track.points[j][0], p[1] - track.points[j][1])).toBeGreaterThan(34);
      }
    });
  });
  it('all six bots finish two laps across city and procedural circuits without walls or off-road trips', () => {
    expect(BOT_RACE_LAPS).toBe(2);
    for (const seed of ['tokyo:test', 'seed-1', 'seed-7', 'seed-12', 'gp5972241-a2732a']) {
      const record = race(seed);
      expect(record.results.every(r => r.finished && r.lapsDone >= 2 && !r.crashed && r.offTracks === 0 && r.wallHits === 0)).toBe(true);
      expect(record.duration).toBeLessThan(230);
    }
  });
  it('finishes a three-lap city race and replays both controller versions deterministically', () => {
    expect(race('tokyo:test', 3).results.every(r => r.finished && r.lapsDone >= 3)).toBe(true);
    for (const version of ['3', '4']) {
      const a = race('tokyo:replay', 2, version), b = race('tokyo:replay', 2, version);
      expect(a.frames).toEqual(b.frames); expect(a.results).toEqual(b.results); expect(a.simVersion).toBe(version);
    }
  });
  it('recovers from a spin into the runoff and finishes the race', () => {
    const sim = new RaceSim(null, { seed: 'tokyo:recovery', entries: entries.slice(0, 1), laps: 2, maxTime: 230, obstacles: true });
    const car = sim.carStates()[0], heading = car.h;
    car.x -= Math.sin(heading) * 19; car.y += Math.cos(heading) * 19; car.h += 2.6;
    try {
      while (!sim.done) sim.step(600);
      expect(sim.results()[0].finished).toBe(true);
      expect(sim.results()[0].wallHits).toBe(0);
    } finally { sim.dispose(); }
  });
  it('assists unsafe new AI League drivers while preserving old races and user agents', async () => {
    const poor: Entry = { name: 'Unsafe driver', model: 'test', color: '#ff006e', source: 'llm', code: 'function drive(){ return {throttle:1,steer:0,brake:0}; }' };
    const cfg = { seed: 'tokyo:assist', entries: [poor], laps: 2, maxTime: 230, obstacles: true };
    const assisted = await simulateRace({ ...cfg, simVersion: '4' });
    expect(assisted.results[0].finished).toBe(true);
    expect(assisted.results[0].offTracks).toBe(0);
    expect(assisted.results[0].wallHits).toBe(0);
    const legacy = await simulateRace({ ...cfg, simVersion: '3' });
    expect(legacy.results[0].finished).toBe(false);
    const agent = await simulateRace({ ...cfg, entries: [{ ...poor, source: 'agent' }], simVersion: '4' });
    expect(agent.results[0].finished).toBe(false);
  });
  it('the generated house driver runs inside the real QuickJS sandbox', async () => {
    const bots: Entry[] = HOUSE_BOTS.slice(0, 3).map((bot, i) => ({ name: bot.name, model: bot.name, color: entries[i].color, code: fallbackDriverCode(bot.params), source: 'house' }));
    const rec = await simulateRace({ seed: 'tokyo:sandbox', entries: bots, laps: 2, maxTime: 230, obstacles: true });
    expect(rec.results.every(r => r.finished && !r.crashed)).toBe(true);
  });
});
