/** Human-friendly, cryptographically random invitation codes (40 bits). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const FRIEND_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
export const FRIEND_LOBBIES_OPEN_LIMIT = 3;
export const FRIEND_LOBBIES_DAILY_LIMIT = 20;

/** Dollar entries use cents; reject coercion, excessive precision and unsafe arithmetic. */
export function friendEntryUsd(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents < 1 || Math.abs(value * 100 - cents) > 1e-7) return null;
  return cents / 100;
}

/** Freeze a whole-token-unit quote once for everyone, including a safe five-seat pot. */
export function friendEntryUnits(coins: number, decimals: number): string | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) return null;
  const units = Math.ceil(coins * 10 ** decimals);
  return Number.isSafeInteger(units) && units > 0 && units <= Math.floor(Number.MAX_SAFE_INTEGER / 5) ? String(units) : null;
}

/** Token-unit arithmetic keeps a custom pot and its 80/15/5 split exact. */
export function splitFriendPot(entryUnits: string, players: number, decimals: number) {
  const pot = BigInt(entryUnits) * BigInt(players), prize = pot * 80n / 100n, burn = pot * 15n / 100n, team = pot - prize - burn;
  const scale = 10 ** decimals;
  return { pot: Number(pot) / scale, prize: Number(prize) / scale, burn: Number(burn) / scale, team: Number(team) / scale, rawUnits: { prize: String(prize), burn: String(burn), team: String(team) } };
}

export function friendCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => ALPHABET[n & 31]).join('');
}

export function normalizeFriendCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  const raw = value.trim();
  const fromLink = /#\/race\/friends\/([^/?#]+)/i.exec(raw)?.[1];
  const code = (fromLink ?? raw).replace(/[\s-]/g, '').toUpperCase();
  return FRIEND_CODE_PATTERN.test(code) ? code : null;
}
