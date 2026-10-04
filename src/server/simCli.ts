// Run a race from the command line: npm run sim -- <seed>
import { simulateRace, type Entry } from '../sim/race';
import { CAR_COLORS, HOUSE_BOTS, fallbackDriverCode } from '../sim/fallbackDriver';

const seed = process.argv[2] ?? 'demo';
const entries: Entry[] = HOUSE_BOTS.map((b, i) => ({
  name: b.name.replace('House Bot ', ''),
  model: b.name,
  color: CAR_COLORS[i],
  code: fallbackDriverCode(b.params),
  source: 'house',
}));

const t0 = performance.now();
const rec = await simulateRace({ seed, entries });
const ms = performance.now() - t0;
console.log(`seed=${seed} laps=${rec.laps} length=${rec.trackLength.toFixed(0)}m duration=${rec.duration.toFixed(1)}s sim=${ms.toFixed(0)}ms`);
for (const r of rec.results) {
  const e = entries[r.car];
  console.log(
    `P${r.position} ${e.name.padEnd(10)} ${r.finished ? r.finishTime!.toFixed(2) + 's' : 'DNF ' + (r.crashReason ?? `${r.progress.toFixed(0)}m`)}`.padEnd(42) +
      ` best=${r.bestLap?.toFixed(2) ?? '-'} contacts=${r.contacts} walls=${r.wallHits} off=${r.offTracks}`,
  );
}
const counts: Record<string, number> = {};
for (const e of rec.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
console.log('events', counts);
