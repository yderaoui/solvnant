import type { Connection, Transaction } from '@solana/web3.js';
import type { CoinQuote } from './coinPurchase';
import { PRIVATE_BUY_CHECK } from '../game/privateBuyCheck';

/** Read-only simulation. No signing or submission. Conservatively reserves the full max coin cost again. */
export async function checkPrivateBuyBudget(tx: Transaction, conn: Connection, q: CoinQuote): Promise<number> {
  if (q.address !== PRIVATE_BUY_CHECK.wallet || tx.feePayer?.toBase58() !== PRIVATE_BUY_CHECK.wallet || q.mint !== PRIVATE_BUY_CHECK.mint || q.revision !== PRIVATE_BUY_CHECK.revision || q.sol !== PRIVATE_BUY_CHECK.inputSol || q.ticket.cluster !== 'mainnet-beta' || !Number.isSafeInteger(q.maxLamports) || q.maxLamports <= 0 || q.maxLamports > 1_010_000) throw new Error('This page only supports the agreed 0.001 SOL owner purchase.');
  const { PublicKey, VersionedTransaction } = await import('@solana/web3.js');
  const owner = new PublicKey(PRIVATE_BUY_CHECK.wallet);
  const before = await conn.getBalanceAndContext(owner, 'confirmed');
  const unsigned = VersionedTransaction.deserialize(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  const result = await conn.simulateTransaction(unsigned, { sigVerify: false, commitment: 'confirmed', minContextSlot: before.context.slot, accounts: { encoding: 'base64', addresses: [PRIVATE_BUY_CHECK.wallet] } });
  if (result.value.err) throw new Error('The purchase simulation failed. No purchase was sent.');
  const after = result.value.accounts?.[0]?.lamports;
  if (typeof after !== 'number' || !Number.isSafeInteger(after)) throw new Error('Could not estimate the total cost. No purchase was sent.');
  const debit = before.value - after;
  if (!Number.isSafeInteger(debit) || debit <= 0 || debit + q.maxLamports > PRIVATE_BUY_CHECK.maxTotalLamports) throw new Error('The estimated cost exceeds this test’s 0.005 SOL limit. No purchase was sent.');
  return debit;
}
