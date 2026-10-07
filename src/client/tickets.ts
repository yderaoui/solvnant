// Race tickets paid in the game coin. The player's wallet (Phantom) sends `price` coins to the
// treasury wallet with a one-time memo; the game server reads that transaction on-chain and credits
// one ticket. Joining a live race uses a ticket; leaving before lights out gives it back.
// No smart contract involved: it's a plain SPL token transfer the player approves in their wallet.
import { account } from './account';
import type { TicketConfig } from '../game/config';

interface SolanaProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signAndSendTransaction(tx: unknown): Promise<{ signature: string }>;
}

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export function walletProvider(): SolanaProvider | null {
  const w = window as unknown as { phantom?: { solana?: SolanaProvider }; solana?: SolanaProvider };
  return w.phantom?.solana ?? w.solana ?? null;
}

export const ticketsOn = () => !!account.cfg?.tickets;

/**
 * Buy one ticket. `step` reports progress for the UI. Resolves with the new ticket count.
 * Throws with a readable message (wallet missing, rejected, not enough coins, …).
 */
/** The wallet that pays: the Privy wallet when Privy is on, else Phantom (or another injected wallet). */
async function payer(): Promise<{ address: string; send: (tx: import('@solana/web3.js').Transaction) => Promise<string> }> {
  const { privyOn, privyWallet } = await import('./privy/client');
  if (privyOn()) {
    const w = await privyWallet();
    const { base58Encode } = await import('../game/solana');
    return {
      address: w.address,
      send: async (tx) => base58Encode(await w.signAndSend(new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })))),
    };
  }
  const provider = walletProvider();
  if (!provider) throw new Error('No Solana wallet found. Install Phantom (phantom.app), then reload this page.');
  const { publicKey } = await provider.connect();
  return { address: publicKey.toString(), send: async (tx) => (await provider.signAndSendTransaction(tx)).signature };
}

export async function buyTicket(step: (text: string) => void): Promise<number> {
  if (!account.me) throw new Error('Sign in first.');
  step('Connecting your wallet…');
  const wallet = await payer();
  const publicKey = { toString: () => wallet.address };
  const intent = await account.api<TicketConfig & { memo: string }>('/api/ticket/intent', {});
  step('Preparing the payment…');
  // The Solana libraries expect Node's Buffer: give the browser one before loading them.
  const { Buffer } = await import('buffer');
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
  const [{ Connection, PublicKey, Transaction, TransactionInstruction }, spl] = await Promise.all([import('@solana/web3.js'), import('@solana/spl-token')]);
  const conn = new Connection(intent.rpcUrl, 'confirmed');
  const owner = new PublicKey(publicKey.toString());
  const mint = new PublicKey(intent.mint);
  const treasury = new PublicKey(intent.treasury);
  const from = spl.getAssociatedTokenAddressSync(mint, owner);
  const to = spl.getAssociatedTokenAddressSync(mint, treasury);
  const units = BigInt(Math.round(intent.price * 10 ** intent.decimals));
  // Friendly errors before the wallet pops up
  try {
    const bal = await conn.getTokenAccountBalance(from);
    if (BigInt(bal.value.amount) < units) throw new Error(`You need ${intent.price} ${intent.symbol} in this wallet (you have ${bal.value.uiAmountString}).`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('You need')) throw e;
    throw new Error(`This wallet has no ${intent.symbol} yet${intent.cluster === 'devnet' ? ' (devnet test coins)' : ''}.`);
  }
  const tx = new Transaction();
  tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(owner, to, treasury, mint)); // treasury's coin account, if new
  tx.add(spl.createTransferCheckedInstruction(from, mint, to, owner, units, intent.decimals));
  tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(intent.memo, 'utf8') }));
  tx.feePayer = owner;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  step(`Approve ${intent.price} ${intent.symbol} in your wallet…`);
  let signature: string;
  try {
    signature = await wallet.send(tx);
  } catch (e) {
    throw new Error(/reject|cancel|denied/i.test(String((e as Error).message)) ? 'You cancelled the payment.' : `Wallet error: ${(e as Error).message}`);
  }
  step('Waiting for the network to confirm…');
  remember(signature);
  for (let i = 0; i < 30; i++) {
    let r: { ok: boolean; pending?: boolean; tickets?: number };
    try {
      r = await account.api<{ ok: boolean; pending?: boolean; tickets?: number }>('/api/ticket/claim', { signature });
    } catch (e) {
      const msg = (e as Error).message;
      if (/already used|memo|costs|failed on-chain|expired/i.test(msg)) throw e; // a real problem with this payment
      r = { ok: false, pending: true }; // network hiccup: keep trying
    }
    if (r.ok) {
      remember(null);
      await account.refresh();
      return r.tickets ?? 0;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`Payment sent but not confirmed yet. It will be credited when it confirms (transaction ${signature.slice(0, 8)}…).`);
}

function remember(sig: string | null) {
  try {
    if (sig) localStorage.setItem('tl-pending-ticket', sig);
    else localStorage.removeItem('tl-pending-ticket');
  } catch {
    /* ignore */
  }
}

/** A purchase whose confirmation we didn't see (tab closed, slow network): credit it now. */
export async function claimPendingTicket(): Promise<boolean> {
  let sig: string | null = null;
  try {
    sig = localStorage.getItem('tl-pending-ticket');
  } catch {
    return false;
  }
  if (!sig || !account.me || !ticketsOn()) return false;
  try {
    const r = await account.api<{ ok: boolean }>('/api/ticket/claim', { signature: sig });
    if (r.ok) {
      remember(null);
      await account.refresh();
      return true;
    }
  } catch {
    remember(null); // expired or invalid: don't keep retrying
  }
  return false;
}

/** Devnet only: ask the site's faucet for free test coins (and a little test SOL for fees). */
export async function getTestCoins(step: (text: string) => void): Promise<string> {
  step('Connecting your wallet…');
  const wallet = await payer();
  const publicKey = { toString: () => wallet.address };
  step('Sending you test coins (about 10 s)…');
  const base = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? 'https://solvnant.vercel.app' : '';
  const r = await fetch(`${base}/api/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: publicKey.toString() }) });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; coins?: number; sol?: number; error?: string };
  if (!r.ok || !j.ok) throw new Error(j.error ?? `Faucet error ${r.status}`);
  const sym = account.cfg?.tickets?.symbol ?? '$TRACK';
  const privy = (await import('./privy/client')).privyOn();
  return `Received ${j.coins} test ${sym}${j.sol ? ` and ${j.sol} test SOL for fees` : ''}.${privy ? ' You can buy a ticket now.' : ' Switch Phantom to the test network (Settings → Developer settings → Testnet mode → Solana Devnet) to see them.'}`;
}
