// Exact token arithmetic for AI League pool bets. Display values never authorize a transfer.
export const LEAGUE_BET_MIN_USD = 0.01;
export const LEAGUE_BET_MAX_USD = 100;
export const LEAGUE_RESULT_TIMEOUT_MS = 15 * 60_000;

export interface CoinPoolBet { id: string; pick: string; units: string }
export function settleCoinPool(bets: CoinPoolBet[], winner: string | null) {
  const amounts = bets.map(b => {
    if (!/^[1-9]\d*$/.test(b.units)) throw new Error('Invalid coin stake.');
    return { ...b, amount: BigInt(b.units) };
  });
  const total = amounts.reduce((s, b) => s + b.amount, 0n);
  const winning = amounts.filter(b => b.pick === winner);
  const backed = winning.reduce((s, b) => s + b.amount, 0n);
  const payouts = new Map<string, string>();
  if (winner === null || backed === 0n) {
    for (const b of amounts) payouts.set(b.id, b.units);
    return { total: String(total), prize: String(total), burn: '0', team: '0', payouts, refunded: true };
  }
  const burn = total * 15n / 100n, team = total * 5n / 100n;
  const prize = total - burn - team;
  let allocated = 0n;
  const shares = winning.map(b => {
    const units = prize * b.amount / backed;
    allocated += units;
    return { id: b.id, units, remainder: prize * b.amount % backed };
  }).sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1);
  // Largest remainder allocation returns every winning base unit, without creating dust fees.
  for (let i = 0; allocated < prize; i++, allocated++) shares[i].units++;
  for (const b of amounts) payouts.set(b.id, '0');
  for (const s of shares) payouts.set(s.id, String(s.units));
  return { total: String(total), prize: String(prize), burn: String(burn), team: String(team), payouts, refunded: false };
}

export function leagueStakeUsd(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-7 || cents < LEAGUE_BET_MIN_USD * 100 || cents > LEAGUE_BET_MAX_USD * 100) return null;
  return cents / 100;
}

/** Use the entire on-chain block second: never count a payment made after the seed reveal. */
export function leaguePaymentInTime(blockTime: number | null | undefined, closesAt: number): boolean {
  return Number.isSafeInteger(blockTime) && blockTime! > 0 && blockTime! * 1000 + 1000 <= closesAt;
}
