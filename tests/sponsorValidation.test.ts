import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { cosignPurchase, cosignWithdrawal, loadHouse, txStatus, blockHeight, type House } from '../src/game/house';
import type { TicketConfig } from '../src/game/config';

// Unfunded disposable fixtures. No keys or transactions from a real account are used.
const player = Keypair.generate(), fixtureHouse = Keypair.generate(), destination = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const cfg: TicketConfig = { mint: mint.toBase58(), cluster: 'devnet', rpcUrl: 'https://rpc.fixture', decimals: 6, price: 1, symbol: '$TEST', treasury: fixtureHouse.publicKey.toBase58() };
let house: House;
beforeAll(async () => { house = (await loadHouse(JSON.stringify([...fixtureHouse.secretKey])))!; });
afterEach(() => vi.unstubAllGlobals());
function mockRpc(result?: object) {
  const bytes = Buffer.alloc(82); bytes[44] = 6;
  const f = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ result: result ?? { value: { owner: TOKEN_PROGRAM_ID.toBase58(), data: [bytes.toString('base64'), 'base64'] } } })));
  vi.stubGlobal('fetch', f); return f;
}
function wire(withdrawal = false, extra: TransactionInstruction[] = [], amount = 1_000_000n) {
  const from = getAssociatedTokenAddressSync(mint, player.publicKey);
  const to = getAssociatedTokenAddressSync(mint, withdrawal ? destination : fixtureHouse.publicKey);
  const tx = new Transaction().add(...extra, createTransferCheckedInstruction(from, mint, to, player.publicKey, amount, 6));
  if (!withdrawal) tx.add(new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from('PumpKart ticket fixture') }));
  tx.feePayer = fixtureHouse.publicKey; tx.recentBlockhash = mint.toBase58(); tx.partialSign(player);
  return tx;
}
const encoded = (tx: Transaction) => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
it('co-signs a valid real player signature and leaves the reviewed message unchanged', async () => {
  mockRpc(); const tx = wire();
  const r = await cosignPurchase(cfg, house, encoded(tx), { priceOf: () => 1 });
  const signed = Transaction.from(Buffer.from(r.wire, 'base64'));
  expect(signed.verifySignatures()).toBe(true);
  expect(signed.serializeMessage().equals(tx.serializeMessage())).toBe(true);
});
it.each([false, true])('rejects invalid player signatures before giving the treasury signature (withdrawal=%s)', async withdrawal => {
  mockRpc(); const tx = wire(withdrawal);
  tx.signatures.find(s => s.publicKey.equals(player.publicKey))!.signature = Buffer.alloc(64);
  const p = withdrawal ? cosignWithdrawal(cfg, house, encoded(tx), true) : cosignPurchase(cfg, house, encoded(tx), { priceOf: () => 1 });
  await expect(p).rejects.toThrow('not signed by you');
});
it.each([false, true])('rejects unbounded priority fees (withdrawal=%s)', async withdrawal => {
  mockRpc(); const tx = wire(withdrawal, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000_000n })]);
  await expect(withdrawal ? cosignWithdrawal(cfg, house, encoded(tx), true) : cosignPurchase(cfg, house, encoded(tx), { priceOf: () => 1 })).rejects.toThrow('priority fees');
});
it('refuses zero-value withdrawals', async () => {
  mockRpc(); await expect(cosignWithdrawal(cfg, house, encoded(wire(true, [], 0n)), true)).rejects.toThrow('zero amount');
});
it('distinguishes a processed payment from one absent in chain history', async () => {
  mockRpc({ value: [{ err: null, confirmationStatus: 'processed' }] });
  expect(await txStatus(cfg, 'fixture-signature')).toEqual({ ok: null, err: null });
  mockRpc({ value: [null] }); expect(await txStatus(cfg, 'fixture-signature')).toBeNull();
});
it('uses finalized block height before allowing a replacement payout', async () => {
  const f = mockRpc(); await blockHeight(cfg);
  expect(JSON.parse(f.mock.calls[0][1]!.body as string).params).toEqual([{ commitment: 'finalized' }]);
});
