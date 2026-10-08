// Ticketed ghost lobbies (the core loop of the build summary):
//   - 5 seats, one track, winner takes all. A seat costs one race ticket (bought with the game coin).
//   - Async PvP: you drive alone against the ghosts (recorded runs) of the players already in the lobby.
//     Ghosts don't collide with you, so every run is a fair solo time trial on the same track.
//   - The server re-simulates every submitted run from its inputs (the sim is deterministic) and only
//     that result counts, so a modified client can't send a fake time.
//   - A run must come back within its own race time (plus slack) of starting, so a player can't try the
//     track several times and only submit the best attempt.
//   - Settles at 5 finished seats, or at 4 after 30 minutes. With 3 or fewer the tickets are refunded.
//   - Pot = seats x ticket price: 80% to the winner, 15% buyback-and-burn, 5% team.
import { RaceSim, type InputLogEntry } from '../sim/race';
import { generateTrack, lapsFor } from '../sim/track';
import { liveSimEntries } from './liveEntries';

export const SEATS = 5;
export const MIN_SEATS = 4;
export const SETTLE_AFTER_MS = 30 * 60_000;
export const COUNTDOWN_S = 3; // client countdown before lights out
export const MAX_RACE_S = 230;
export const SUBMIT_SLACK_S = 25; // network + finishing animation
const EARLY_TOLERANCE_S = 3; // clock jitter
export const SPLIT = { prize: 0.8, burn: 0.15, team: 0.05 } as const;
const MAX_LOG = 20_000;

export interface RunResult {
  finished: boolean;
  finishTime: number | null; // s
  progress: number; // m along the race
  crashed: boolean;
  endTick: number; // last input tick (how long the run was driven)
}

/** Checks the shape of a submitted input log. Returns null if it's well formed, else why not. */
export function badLog(log: unknown): string | null {
  if (!Array.isArray(log)) return 'no inputs';
  if (log.length > MAX_LOG) return 'too many inputs';
  let prev = -1;
  for (const e of log) {
    if (!Array.isArray(e) || e.length !== 5) return 'bad input';
    const [tick, car, th, st, br] = e as number[];
    if (!Number.isInteger(tick) || tick < 0 || tick < prev || tick > MAX_RACE_S * 60) return 'bad tick';
    if (car !== 0) return 'bad car';
    for (const [v, lo] of [
      [th, 0],
      [st, -1],
      [br, 0],
    ] as const)
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > 1 || Math.round(v * 100) / 100 !== v) return 'bad value';
    prev = tick;
  }
  return null;
}

/** The solo race every run of a lobby is driven in (same config on the client). */
export function soloConfig(seed: string, inputLog?: InputLogEntry[]) {
  return {
    seed,
    entries: liveSimEntries([{ name: 'You', color: '#ffffff', kind: 'human' as const, bot: null }]),
    laps: lapsFor(generateTrack(seed)),
    maxTime: MAX_RACE_S,
    obstacles: true,
    inputLog,
  };
}

/** Re-run a submitted run on the server: this is the official result. */
export function replayRun(seed: string, log: InputLogEntry[]): RunResult {
  const sim = new RaceSim(null, soloConfig(seed, log));
  while (!sim.done) sim.stepTick();
  const r = sim.results()[0];
  return { finished: r.finished, finishTime: r.finishTime, progress: r.progress, crashed: r.crashed, endTick: log.length ? log[log.length - 1][0] : 0 };
}

export interface SeatRow {
  uid: string;
  finished: boolean;
  finishTime: number | null;
  progress: number;
  started: number;
}

/** Ranking: first across the line wins (finish time), then the furthest along, then who started first. */
export function rank<T extends SeatRow>(seats: T[]): T[] {
  return [...seats].sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime! - b.finishTime! || a.started - b.started;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress || a.started - b.started;
  });
}

/** How a pot is split (amounts in coins, rounded to 6 decimals; the team gets the rounding). */
export function split(seats: number, price: number) {
  return splitPot(seats * price);
}

/** Split a pot of coins (what was actually paid in): 80% winner, 15% burned, 5% team. */
export function splitPot(pot: number) {
  const r = (v: number) => Math.floor(v * 1e6) / 1e6;
  const prize = r(pot * SPLIT.prize);
  const burn = r(pot * SPLIT.burn);
  return { pot, prize, burn, team: Math.round((pot - prize - burn) * 1e6) / 1e6 }; // the exact remainder
}

/** What should happen to a lobby now. */
export function lobbyVerdict(created: number, now: number, seats: { done: boolean }[]): 'wait' | 'settle' | 'refund' {
  const racing = seats.some((s) => !s.done);
  if (seats.length >= SEATS && !racing) return 'settle';
  if (now - created < SETTLE_AFTER_MS || racing) return 'wait';
  return seats.length >= MIN_SEATS ? 'settle' : 'refund';
}

/**
 * A run comes back about as long after it started as it took to drive: not much later (no time to try the
 * track several times and keep the best) and not sooner (a time computed by a program, not driven live).
 */
export function submittedInTime(startedMs: number, submittedMs: number, r: RunResult): 'ok' | 'early' | 'late' {
  const drove = r.finished ? r.finishTime! : r.endTick / 60;
  const took = (submittedMs - startedMs) / 1000;
  if (took < COUNTDOWN_S + drove - EARLY_TOLERANCE_S) return 'early';
  return took <= COUNTDOWN_S + drove + SUBMIT_SLACK_S ? 'ok' : 'late';
}
