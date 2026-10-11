import { beforeEach, expect, it, vi } from 'vitest';
import { Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
vi.mock('../src/client/account', () => ({ account: {} }));
vi.mock('../src/client/tickets', () => ({ payer: vi.fn() }));
import { reviewCoinBuyCost, type CoinQuote } from '../src/client/coinPurchase';
const address = '4tWo1pQfrtFbw94HW9NScGmmWNH2Y8u7D9DGxPC6AGpH';
const owner = new PublicKey(address), conn = new Connection('https://fixture.invalid');
const tx = () => new Transaction({ feePayer: owner, recentBlockhash: 'So11111111111111111111111111111111111111112' }).add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 1 }));
const q = { address, maxLamports: 1_010_000 } as CoinQuote;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(conn, 'getBalanceAndContext').mockResolvedValue({ context: { slot: 123 }, value: 188_229_983 });
  vi.spyOn(conn, 'simulateTransaction').mockResolvedValue({ context: { slot: 123 }, value: { err: null, logs: [], accounts: [{ lamports: 184_364_944, owner: '11111111111111111111111111111111', executable: false, data: ['', 'base64'], rentEpoch: 0 }] } });
});
it('estimates full debit using an unsigned simulation, without signing or sending', async () => {
  const send = vi.spyOn(conn, 'sendRawTransaction');
  expect(await reviewCoinBuyCost(q, tx(), conn)).toEqual({ totalLamports: 3_865_039, balanceLamports: 188_229_983 });
  expect(conn.simulateTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sigVerify: false, minContextSlot: 123, accounts: { encoding: 'base64', addresses: [address] } }));
  expect(send).not.toHaveBeenCalled();
});
it('rejects failed and incomplete simulations instead of showing a fabricated fee estimate', async () => {
  vi.spyOn(conn, 'simulateTransaction').mockResolvedValueOnce({ context: { slot: 123 }, value: { err: { InstructionError: [0, 'fixture'] }, logs: [] } });
  await expect(reviewCoinBuyCost(q, tx(), conn)).rejects.toThrow('could not be simulated');
  vi.spyOn(conn, 'simulateTransaction').mockResolvedValueOnce({ context: { slot: 123 }, value: { err: null, logs: [] } });
  await expect(reviewCoinBuyCost(q, tx(), conn)).rejects.toThrow('Could not estimate');
});
it('retains the SOL buffer including account setup before approval', async () => {
  vi.spyOn(conn, 'getBalanceAndContext').mockResolvedValue({ context: { slot: 123 }, value: 12_000_000 });
  vi.spyOn(conn, 'simulateTransaction').mockResolvedValue({ context: { slot: 123 }, value: { err: null, logs: [], accounts: [{ lamports: 8_000_000, owner: '11111111111111111111111111111111', executable: false, data: ['', 'base64'], rentEpoch: 0 }] } });
  await expect(reviewCoinBuyCost(q, tx(), conn)).rejects.toThrow('0.01 SOL after');
});
