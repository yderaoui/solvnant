// Live race grid -> simulation entries. Shared by the game server (racing) and the browser (replays),
// so a stored live race re-simulates exactly: humans replay their logged inputs, bots are the house
// bots with a little less grip.
import type { Entry } from '../sim/race';
import { HOUSE_BOTS } from '../sim/fallbackDriver';

export interface LiveGridEntry {
  name: string;
  color: string;
  kind: 'human' | 'bot';
  bot: number | null; // house bot index for bots
}

export function liveSimEntries(entries: LiveGridEntry[]): Entry[] {
  return entries.map((e) => {
    const b = e.kind === 'bot' ? HOUSE_BOTS[e.bot ?? 0] : null;
    return {
      name: e.name,
      model: b ? b.name : `player:${e.name}`,
      color: e.color,
      code: '',
      source: e.kind === 'human' ? 'human' : 'bot',
      botParams: b ? { ...b.params, grip: b.params.grip * 0.92 } : undefined,
    };
  });
}
