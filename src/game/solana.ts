// Wallet linking and the token gate. Read-only: we check a signature (proof that the person owns the
// wallet) and look up how much of the game's token the wallet holds. Nothing is ever sent on-chain.
import type { GateConfig } from './config';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('invalid base58');
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = n * 256n + BigInt(x);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = '1' + s;
  }
  return s;
}

export function isSolanaAddress(a: string): boolean {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && base58Decode(a).length === 32;
  } catch {
    return false;
  }
}

/** The exact text the wallet signs. Free, off-chain, moves nothing. */
export function walletMessage(uid: string, nonce: string): string {
  return `TrackLab 3D: link this wallet to my account.\nAccount: ${uid}\nNonce: ${nonce}\nSigning this is free and does not move any funds.`;
}

/** Ed25519 check that `signature` (base58 or base64) over `message` came from `address`. */
export async function verifyWalletSignature(address: string, message: string, signature: string): Promise<boolean> {
  if (!isSolanaAddress(address)) return false;
  let sig: Uint8Array;
  try {
    sig = /^[1-9A-HJ-NP-Za-km-z]+$/.test(signature) ? base58Decode(signature) : Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', base58Decode(address) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, sig as BufferSource, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

export interface Holding {
  amount: number; // tokens
  priceUsd: number | null;
  usd: number | null;
}

/** How much of the gate token a wallet holds, and what it's worth (DexScreener price). */
export async function tokenHolding(owner: string, gate: GateConfig, fetchFn: typeof fetch = fetch): Promise<Holding> {
  const rpc = await fetchFn(gate.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [owner, { mint: gate.mint }, { encoding: 'jsonParsed' }] }),
  });
  if (!rpc.ok) throw new Error(`Solana RPC error ${rpc.status}`);
  const j = (await rpc.json()) as { result?: { value?: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }[] }; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  const amount = (j.result?.value ?? []).reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
  let priceUsd: number | null = null;
  try {
    const dx = await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${gate.mint}`);
    if (dx.ok) {
      const d = (await dx.json()) as { pairs?: { priceUsd?: string; liquidity?: { usd?: number } }[] };
      const best = (d.pairs ?? []).filter((p) => p.priceUsd).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (best?.priceUsd) priceUsd = Number(best.priceUsd);
    }
  } catch {
    /* price unknown */
  }
  return { amount, priceUsd, usd: priceUsd === null ? null : amount * priceUsd };
}

// ---------------------------------------------------------------- race tickets
import type { TicketConfig } from './config';

export interface TicketPayment {
  wallet: string; // who paid (the fee payer / signer)
  amount: number; // coins received by the treasury
}

interface TokenBalance {
  owner?: string;
  mint: string;
  uiTokenAmount: { uiAmount: number | null };
}

interface ParsedTx {
  meta: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
  transaction: {
    message: {
      accountKeys: { pubkey: string; signer: boolean }[];
      instructions: { program?: string; programId?: string; parsed?: unknown }[];
    };
  };
}

/**
 * Check a ticket payment on-chain: the transaction succeeded, carries our one-time memo, and moved at
 * least `price` of the coin into the treasury wallet. Returns null if it isn't visible yet (retry).
 */
export async function verifyTicketPayment(cfg: TicketConfig, signature: string, memo: string, fetchFn: typeof fetch = fetch): Promise<TicketPayment | null> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(signature)) throw new Error('That is not a transaction signature.');
  const r = await fetchFn(cfg.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] }),
  });
  if (!r.ok) throw new Error(`Solana RPC error ${r.status}`);
  const j = (await r.json()) as { result: ParsedTx | null; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  const tx = j.result;
  if (!tx || !tx.meta) return null; // not confirmed yet
  if (tx.meta.err) throw new Error('The payment transaction failed on-chain.');
  const memos = tx.transaction.message.instructions.filter((i) => i.program === 'spl-memo').map((i) => String(i.parsed));
  if (!memos.includes(memo)) throw new Error('This payment is not for this ticket (memo mismatch).');
  const bal = (list: TokenBalance[] | undefined) =>
    (list ?? []).filter((b) => b.owner === cfg.treasury && b.mint === cfg.mint).reduce((s, b) => s + (b.uiTokenAmount.uiAmount ?? 0), 0);
  const received = bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
  if (received + 1e-9 < cfg.price) throw new Error(`The treasury received ${received} coins, a ticket costs ${cfg.price}.`);
  const wallet = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey ?? '';
  return { wallet, amount: received };
}
