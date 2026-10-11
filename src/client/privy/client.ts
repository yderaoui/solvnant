// Glue between Privy (React island, loaded on demand) and the game's own account/session.
// Privy proves who you are; the game server turns that into its own session (points, tickets...).
import { account } from '../account';
import type { PrivyState, SolanaChain } from './island';

let state: PrivyState | null = null;
let mounting: Promise<void> | null = null;
let exchanging = false;
const waiters = new Set<() => void>();

export const privyOn = () => !!account.cfg?.privy;

function chain(): SolanaChain {
  return account.cfg?.tickets?.cluster === 'mainnet-beta' ? 'solana:mainnet' : 'solana:devnet';
}

/** Load Privy (once) and wait until it knows whether the person is signed in. */
async function ensure(timeoutMs = 20_000): Promise<PrivyState> {
  if (!privyOn()) throw new Error('Privy is not set up.');
  mounting ??= import('./island').then(({ mountPrivy }) => mountPrivy(account.cfg!.privy!, chain(), onState, account.cfg?.tickets?.rpcUrl)).catch(error => { mounting = null; throw error; });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(ready);
      if (error) reject(error); else resolve();
    };
    const ready = () => finish();
    const timer = setTimeout(() => finish(new Error('Your wallet could not finish loading. Please retry.')), timeoutMs);
    mounting!.then(() => {
      if (settled) return;
      if (state?.ready) finish(); else waiters.add(ready);
    }).catch(finish);
  });
  return state!;
}

/** Warm login and existing wallets so the first payment needn't load the entire SDK. */
export function preloadPrivy() {
  if (privyOn()) void ensure().catch(() => {});
}

function onState(s: PrivyState) {
  state = s;
  if (s.ready) waiters.forEach((w) => w());
  // Just signed in with Privy: get a game session for it.
  if (s.ready && s.authenticated && !account.me && !exchanging) void exchange(s).catch(() => {});
}

async function exchange(s: PrivyState) {
  exchanging = true;
  try {
    const token = await s.getAccessToken();
    if (!token) return;
    const u = s.user;
    const handle = u?.twitter?.username ?? null;
    const name = u?.twitter?.name ?? u?.google?.name ?? u?.email?.address?.split('@')[0] ?? (s.wallet ? `${s.wallet.address.slice(0, 4)}…${s.wallet.address.slice(-4)}` : 'Racer');
    const avatar = u?.twitter?.profilePictureUrl ?? null;
    const r = await account.api<{ token: string }>('/api/privy', { token, handle, name, avatar });
    await account.setToken(r.token);
  } finally {
    exchanging = false;
  }
}

/** Open Privy's sign-in (X). */
export async function privyLogin() {
  const s = await ensure();
  if (s.authenticated) {
    if (!account.me) await exchange(s);
  } else s.login();
}

export async function privyLogout() {
  if (!mounting) return;
  const s = await ensure().catch(() => null);
  if (s?.authenticated) await s.logout();
}

/** The player's Solana wallet via Privy (embedded wallet is created at sign-in). */
export async function privyWallet(timeoutMs = 20_000): Promise<NonNullable<PrivyState['wallet']>> {
  const deadline = Date.now() + timeoutMs;
  const s = await ensure(timeoutMs);
  if (!s.authenticated) throw new Error('Sign in first.');
  while (!state?.wallet) {
    if (!state?.authenticated) throw new Error('Sign in first.');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Your wallet is still being created. Please retry in a few seconds.');
    await new Promise((r) => setTimeout(r, Math.min(300, remaining)));
  }
  if (!state.authenticated) throw new Error('Sign in first.');
  return state.wallet;
}
