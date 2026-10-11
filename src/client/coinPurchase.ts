import { account } from './account';
import { payer } from './tickets';
import type { TicketConfig } from '../game/config';
import type { PumpBuyQuote } from '../game/pumpTrade';

export interface CoinQuote extends PumpBuyQuote {
  mint: string; symbol: string; decimals: number; revision: string;
  address: string; expires: number; sol: number; ticket: TicketConfig;
}

/** Bound read requests so a stalled RPC returns a useful retry instead of spinning forever. */
export async function coinConnection(t: TicketConfig) {
  const { Connection } = await import('@solana/web3.js');
  return new Connection(t.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }) });
}

async function unsignedPurchase(q: CoinQuote, conn: import('@solana/web3.js').Connection) {
  const { PublicKey, Transaction, ComputeBudgetProgram } = await import('@solana/web3.js');
  const latest = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ ...latest, feePayer: new PublicKey(q.address) });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...q.instructions);
  return { tx, latest };
}

/** Simulate without signatures; include network fees and any token-account setup in the review. */
export async function estimateCoinBuy(q: CoinQuote) {
  const conn = await coinConnection(q.ticket);
  const { tx } = await unsignedPurchase(q, conn);
  return reviewCoinBuyCost(q, tx, conn);
}

export async function reviewCoinBuyCost(q: CoinQuote, tx: import('@solana/web3.js').Transaction, conn: import('@solana/web3.js').Connection) {
  const { PublicKey, VersionedTransaction } = await import('@solana/web3.js');
  const before = await conn.getBalanceAndContext(new PublicKey(q.address), 'confirmed');
  if (before.value < q.maxLamports + 10_000_000) throw new Error('Keep at least 0.01 SOL beyond the purchase for fees and account setup.');
  const unsigned = VersionedTransaction.deserialize(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  const result = await conn.simulateTransaction(unsigned, { sigVerify: false, commitment: 'confirmed', minContextSlot: before.context.slot,
    accounts: { encoding: 'base64', addresses: [q.address] } });
  if (result.value.err) throw new Error('This purchase could not be simulated. Refresh the price or add SOL for account setup. Nothing was sent.');
  const after = result.value.accounts?.[0]?.lamports;
  const total = typeof after === 'number' ? before.value - after : NaN;
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Could not estimate the total cost. Try reviewing again. Nothing was sent.');
  // Reserve the full price allowance in addition to the simulated debit, which includes fees.
  if (before.value < total + q.maxLamports + 10_000_000) throw new Error('Keep at least 0.01 SOL after the purchase and account setup.');
  return { totalLamports: total, balanceLamports: before.value };
}

export async function quoteCoinBuy(sol: number): Promise<CoinQuote> {
  if (!account.me) throw new Error('Sign in with X first.');
  if (!Number.isFinite(sol) || sol < 0.001 || sol > 10) throw new Error('Enter between 0.001 and 10 SOL.');
  const fresh = await account.api<NonNullable<typeof account.cfg>>('/api/config');
  if (fresh.coinLaunch.status !== 'live' || !fresh.coinLaunch.buyEnabled || !fresh.tickets) throw new Error('Official coin buying is not open yet. No payment was made.');
  if (fresh.tickets.cluster !== 'mainnet-beta') throw new Error('Pump.fun purchases are available on Solana mainnet only.');
  if (account.cfg?.coinLaunch.revision !== fresh.coinLaunch.revision) { account.cfg = fresh; throw new Error('Coin settings changed. Refresh this page before buying.'); }
  // Anchor/Pump read Buffer during module initialization, before a quote function runs.
  const { Buffer } = await import('buffer');
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
  const [wallet, { buildPumpBuy }] = await Promise.all([payer(), import('../game/pumpTrade')]);
  await checkPendingCoinBuy(fresh.tickets, wallet.address);
  const q = await buildPumpBuy(fresh.tickets, wallet.address, sol);
  await account.api('/api/coin/preflight', { mint: fresh.tickets.mint, coinRevision: fresh.coinLaunch.revision, purpose: 'coin' });
  return { ...q, mint: fresh.tickets.mint, symbol: fresh.tickets.symbol, decimals: fresh.tickets.decimals, address: wallet.address, revision: fresh.coinLaunch.revision, ticket: fresh.tickets, expires: Date.now() + 30_000, sol };
}

export async function approveCoinBuy(q: CoinQuote, step: (text: string) => void, reviewTransaction?: (tx: import('@solana/web3.js').Transaction, conn: import('@solana/web3.js').Connection) => Promise<void>): Promise<string> {
  if (Date.now() > q.expires) throw new Error('This quote expired. Get a fresh quote before buying.');
  const guard = () => account.api('/api/coin/preflight', { mint: q.mint, coinRevision: q.revision, purpose: 'coin' });
  await guard();
  const wallet = await payer();
  if (wallet.address !== q.address) throw new Error('Wallet changed. Get a new quote.');
  if (!wallet.signOnly) throw new Error('Use your signed-in game wallet to buy coins here. You can transfer SOL into it from another wallet.');
  await checkPendingCoinBuy(q.ticket, wallet.address);
  const { Buffer } = await import('buffer');
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
  const { PublicKey, Transaction } = await import('@solana/web3.js');
  const conn = await coinConnection(q.ticket);
  const { tx, latest } = await unsignedPurchase(q, conn);
  const [feeResult, balance] = await Promise.all([conn.getFeeForMessage(tx.compileMessage()), conn.getBalance(new PublicKey(wallet.address))]);
  const fee = feeResult.value;
  if (fee === null) throw new Error('Could not estimate network fees. Refresh your quote.');
  if (balance < q.maxLamports + fee + 10_000_000) throw new Error('Keep at least 0.01 SOL beyond the purchase amount for network fees and account setup.');
  if (reviewTransaction) await reviewTransaction(tx, conn);
  await guard();
  if (Date.now() > q.expires) throw new Error('This quote expired. Review a fresh price. Nothing was sent.');
  step('Approve in your wallet, then click Close to finish the purchase here.');
  let signature: string;
  if (wallet.signOnly) {
    const bytes = await wallet.signOnly(tx);
    if (Date.now() > q.expires) throw new Error('Quote expired during wallet approval. Nothing was sent. Review a fresh price, approve, then click Close in the wallet promptly.');
    await guard();
    const signed = Transaction.from(bytes);
    if (!signed.signature) throw new Error('The wallet did not sign the purchase.');
    const { base58Encode } = await import('../game/solana');
    signature = base58Encode(new Uint8Array(signed.signature));
    remember(signature, wallet.address, latest.lastValidBlockHeight);
    try { await conn.sendRawTransaction(bytes, { skipPreflight: false, maxRetries: 3 }); }
    catch { throw new Error(`Submission uncertain. Check transaction ${signature} before buying again.`); }
  } else throw new Error('The game wallet cannot sign this purchase.');
  step('Checking your purchase. Do not buy again while it is pending.');
  for (let i = 0; i < 30; i++) {
    let result;
    try { result = (await conn.getSignatureStatuses([signature])).value[0]; }
    catch { throw new Error(`Purchase submitted; confirmation is unavailable. Check transaction ${signature} before buying again.`); }
    if (result?.err) throw new Error(`Purchase failed on-chain (${signature}). Network fees may still apply.`);
    if (result?.confirmationStatus === 'confirmed' || result?.confirmationStatus === 'finalized') {
      pendingMemory.delete(wallet.address);
      try { sessionStorage.removeItem(`pumpkart-pending-coin:${wallet.address}`); } catch { /* optional */ }
      return signature;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`Confirmation is still pending. Check transaction ${signature} before buying again.`);
}

function remember(signature: string, address: string, lastValid: number) {
  const pending = { signature, lastValid };
  pendingMemory.set(address, pending);
  try { sessionStorage.setItem(`pumpkart-pending-coin:${address}`, JSON.stringify(pending)); } catch { /* memory retains the pending transaction */ }
}

const pendingMemory = new Map<string, { signature: string; lastValid: number }>();
async function checkPendingCoinBuy(t: TicketConfig, address: string) {
  let pending = pendingMemory.get(address);
  if (!pending) { try { pending = JSON.parse(sessionStorage.getItem(`pumpkart-pending-coin:${address}`) ?? 'null'); } catch { /* optional */ } }
  if (!pending) return;
  const conn = await coinConnection(t);
  const result = (await conn.getSignatureStatuses([pending.signature], { searchTransactionHistory: true })).value[0];
  if (result?.err || result?.confirmationStatus === 'confirmed' || result?.confirmationStatus === 'finalized' || (!result && await conn.getBlockHeight('confirmed') > pending.lastValid)) {
    pendingMemory.delete(address);
    try { sessionStorage.removeItem(`pumpkart-pending-coin:${address}`); } catch { /* optional */ }
    return;
  }
  throw new Error(`Your previous purchase is still pending. Check transaction ${pending.signature} before buying again.`);
}
