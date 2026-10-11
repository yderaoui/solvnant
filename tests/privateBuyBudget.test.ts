import { beforeEach, expect, it, vi } from 'vitest';
import { Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { PRIVATE_BUY_CHECK } from '../src/game/privateBuyCheck';
import { checkPrivateBuyBudget } from '../src/client/privateBuyBudget';
import type { CoinQuote } from '../src/client/coinPurchase';
const owner = new PublicKey(PRIVATE_BUY_CHECK.wallet);
const blockhash = 'So11111111111111111111111111111111111111112';
const conn = new Connection('https://fixture.invalid');
const tx = () => new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 1 }));
const q = (): CoinQuote => ({ address: PRIVATE_BUY_CHECK.wallet, mint: PRIVATE_BUY_CHECK.mint, revision: PRIVATE_BUY_CHECK.revision, sol: 0.001, maxLamports: 1_010_000, route: 'PumpSwap', tokens: '1', symbol: '$RACE', decimals: 6, expires: Date.now() + 30_000, instructions: [], ticket: { cluster: 'mainnet-beta', rpcUrl: 'https://fixture.invalid', mint: PRIVATE_BUY_CHECK.mint, treasury: '11111111111111111111111111111111', decimals: 6, symbol: '$RACE', price: 0 } });
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(conn, 'getBalanceAndContext').mockResolvedValue({ context: { slot: 123 }, value: 188_229_983 });
  vi.spyOn(conn, 'simulateTransaction').mockResolvedValue({ context: { slot: 123 }, value: { err: null, logs: [], accounts: [{ lamports: 184_364_944, owner: '11111111111111111111111111111111', executable: false, data: ['', 'base64'], rentEpoch: 0 }] } });
});
it('simulates unsigned and includes account setup, network fees and a conservative price reserve', async () => {
  expect(await checkPrivateBuyBudget(tx(), conn, q())).toBe(3_865_039);
  expect(conn.simulateTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sigVerify: false, minContextSlot: 123, accounts: { encoding: 'base64', addresses: [PRIVATE_BUY_CHECK.wallet] } }));
});
it('blocks changed wallets, coins and larger purchase amounts before RPC', async () => {
  for (const changed of [{ address: 'wrong-wallet' }, { mint: 'wrong-mint' }, { sol: 0.01 }, { maxLamports: 2_000_000 }, { maxLamports: NaN }, { revision: 'wrong-revision' }]) await expect(checkPrivateBuyBudget(tx(), conn, { ...q(), ...changed })).rejects.toThrow('agreed');
  expect(conn.simulateTransaction).not.toHaveBeenCalled();
});
it('rejects a conservative total above the limit', async () => {
  vi.spyOn(conn, 'getBalanceAndContext').mockResolvedValue({ context: { slot: 123 }, value: 200_000_000 });
  await expect(checkPrivateBuyBudget(tx(), conn, q())).rejects.toThrow('0.005 SOL limit');
});
it('fails closed on simulation errors and missing account balances', async () => {
  vi.spyOn(conn, 'simulateTransaction').mockResolvedValue({ context: { slot: 123 }, value: { err: { InstructionError: [0, 'InvalidArgument'] }, logs: [] } });
  await expect(checkPrivateBuyBudget(tx(), conn, q())).rejects.toThrow('simulation failed');
  vi.spyOn(conn, 'simulateTransaction').mockResolvedValue({ context: { slot: 123 }, value: { err: null, logs: [] } });
  await expect(checkPrivateBuyBudget(tx(), conn, q())).rejects.toThrow('estimate the total');
});
