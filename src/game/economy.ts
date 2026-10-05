// Points maths, shared by the server and the browser (for showing odds). Integers only: points
// never get fractional, and rounding dust never creates points out of nothing.

/** Prize split of a live-race pot among the human drivers, by finishing order. */
export const PRIZE_SHARES = [60, 30, 10];

/**
 * @param pot total points in the pot
 * @param placed human drivers in finishing order (best first)
 * @returns points per driver, same order. With fewer than 3 drivers the shares are renormalised
 *          (2 drivers: 67/33; 1 driver: gets the pot back). Rounding remainder goes to the winner.
 */
export function prizeSplit(pot: number, placed: number): number[] {
  if (placed <= 0 || pot <= 0) return [];
  const shares = PRIZE_SHARES.slice(0, Math.min(placed, PRIZE_SHARES.length));
  const total = shares.reduce((a, b) => a + b, 0);
  const out = shares.map((s) => Math.floor((pot * s) / total));
  out[0] += pot - out.reduce((a, b) => a + b, 0);
  while (out.length < placed) out.push(0);
  return out;
}

export interface PoolBet {
  uid: string;
  pick: string;
  amount: number;
}

export interface PoolResult {
  payouts: Map<string, number>; // uid -> points returned (stake included)
  rake: number; // burned
  refunded: boolean; // nobody backed the winner (or the market was void): everyone gets their stake back
}

/**
 * Pari-mutuel settlement: all stakes form one pool; after the rake, winners share it in proportion
 * to their stake. If nobody backed the winner, every stake is refunded (no rake).
 */
export function settlePool(bets: PoolBet[], winner: string | null, rakePct: number): PoolResult {
  const payouts = new Map<string, number>();
  const add = (uid: string, v: number) => payouts.set(uid, (payouts.get(uid) ?? 0) + v);
  const total = bets.reduce((s, b) => s + b.amount, 0);
  const winning = bets.filter((b) => b.pick === winner);
  const winStake = winning.reduce((s, b) => s + b.amount, 0);
  if (winner === null || winStake === 0) {
    for (const b of bets) add(b.uid, b.amount);
    return { payouts, rake: 0, refunded: true };
  }
  const rake = Math.floor((total * rakePct) / 100);
  const pool = total - rake;
  let paid = 0;
  for (const b of winning) {
    const p = Math.floor((pool * b.amount) / winStake);
    add(b.uid, p);
    paid += p;
  }
  // rounding dust is burned with the rake
  return { payouts, rake: rake + (pool - paid), refunded: false };
}

/** Current payout multiplier per pick (what 1 point would return if that pick wins now). */
export function poolOdds(pools: Record<string, number>, rakePct: number): Record<string, number | null> {
  const total = Object.values(pools).reduce((a, b) => a + b, 0);
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(pools)) out[k] = v > 0 ? Math.round(((total * (1 - rakePct / 100)) / v) * 100) / 100 : null;
  return out;
}
