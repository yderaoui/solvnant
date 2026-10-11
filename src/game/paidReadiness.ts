import type { TicketConfig } from './config';
import { isSolanaAddress } from './solana';

// Launch reserve for sponsored fees and fresh winner/team token accounts.
// It is a minimum to open tests, not a guarantee of unlimited sponsored transactions.
export const PAID_LAUNCH_RESERVE = 20_000_000;

export async function paidReadinessProblem(
  t: TicketConfig,
  houseAddress: string | null,
  teamWallet: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  if (houseAddress !== t.treasury) return 'Paid races need the configured payout wallet to match the treasury. Buying stays paused.';
  if (!teamWallet || !isSolanaAddress(teamWallet)) return 'Configure a valid team wallet for the 5% share before opening paid races.';
  const url = new URL(t.verifyUrl || t.rpcUrl);
  if (t.verifyUrl) url.searchParams.set('cluster', t.cluster);
  try {
    const r = await fetchFn(url, {
      method: 'POST', signal: AbortSignal.timeout(12_000),
      headers: { 'content-type': 'application/json', ...(t.verifyKey ? { 'x-rpc-key': t.verifyKey } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [t.treasury, { commitment: 'confirmed' }] }),
    });
    const j = await r.json() as { result?: { value?: number }; error?: unknown };
    const value = j.result?.value;
    if (!r.ok || j.error || !Number.isSafeInteger(value) || value! < 0) throw new Error('Balance unavailable');
    if (value! < PAID_LAUNCH_RESERVE) return 'The treasury needs at least 0.02 SOL for sponsored fees and payouts before opening paid races.';
    return null;
  } catch { return 'Cannot verify treasury funding. Paid races stay paused; retry when the network is available.'; }
}
