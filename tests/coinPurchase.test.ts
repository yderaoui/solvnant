import { beforeEach, expect, it, vi } from 'vitest';
import { PublicKey, Transaction, Keypair, SystemProgram } from '@solana/web3.js';

const mock = vi.hoisted(() => ({ api: vi.fn(), payer: vi.fn(), build: vi.fn(), sign: vi.fn(), block: vi.fn(), fees: vi.fn(), balance: vi.fn(), send: vi.fn(), statuses: vi.fn() }));
vi.mock('../src/client/account', () => ({ account: { me: { id:'fixture' }, cfg: { coinLaunch: { status:'live', revision:'v1',buyEnabled:true } }, api:mock.api } }));
vi.mock('../src/client/tickets', () => ({ payer: mock.payer }));
vi.mock('../src/game/pumpTrade', () => ({ buildPumpBuy: mock.build }));
import { account } from '../src/client/account';
import { approveCoinBuy, quoteCoinBuy, type CoinQuote } from '../src/client/coinPurchase';
import { Connection } from '@solana/web3.js';
const wallet = Keypair.generate(); // Ephemeral fixture; no real wallet or funds.
const mint = 'So11111111111111111111111111111111111111112';
let cfg: any;
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  cfg = { coinLaunch:{status:'live',revision:'v1',buyEnabled:true},tickets:{mint,cluster:'mainnet-beta',symbol:'$FIXTURE',decimals:6,rpcUrl:'https://rpc.fixture'} };
  account.cfg = cfg;
  mock.api.mockResolvedValue(cfg);
  mock.payer.mockResolvedValue({address:wallet.publicKey.toBase58(),signOnly:mock.sign});
  mock.build.mockResolvedValue({route:'pump.fun',tokens:'1000000',maxLamports:50_500_000,instructions:[]});
  vi.spyOn(Connection.prototype,'getLatestBlockhash').mockResolvedValue({blockhash:mint,lastValidBlockHeight:100});
  vi.spyOn(Connection.prototype,'getFeeForMessage').mockResolvedValue({context:{slot:1},value:5000});
  vi.spyOn(Connection.prototype,'getBalance').mockResolvedValue(1_000_000_000);
  vi.spyOn(Connection.prototype,'getBalanceAndContext').mockResolvedValue({ context: { slot: 1 }, value: 1_000_000_000 });
  vi.spyOn(Connection.prototype,'simulateTransaction').mockResolvedValue({ context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ lamports: 950_000_000 } as any] } });
  vi.spyOn(Connection.prototype,'isBlockhashValid').mockResolvedValue({ context: { slot: 1 }, value: true });
  vi.spyOn(Connection.prototype,'sendRawTransaction').mockImplementation(mock.send);
  vi.spyOn(Connection.prototype,'getSignatureStatuses').mockImplementation(mock.statuses);
});
function quote(): CoinQuote {
  return {route:'pump.fun',tokens:'1000000',maxLamports:50_500_000,instructions:[SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:new PublicKey(mint),lamports:1})],mint,symbol:'$FIXTURE',decimals:6,revision:'v1',address:wallet.publicKey.toBase58(),expires:Date.now()+30_000,sol:0.05,ticket:cfg.tickets};
}
it('blocks a paused launch before connecting, quoting or signing', async () => {
  mock.api.mockResolvedValue({...cfg,coinLaunch:{...cfg.coinLaunch,status:'paused'}});
  await expect(quoteCoinBuy(0.05)).rejects.toThrow('not open');
  expect(mock.payer).not.toHaveBeenCalled(); expect(mock.build).not.toHaveBeenCalled(); expect(mock.sign).not.toHaveBeenCalled();
});
it('rejects a stale page and does not silently substitute a new mint', async () => {
  mock.api.mockResolvedValue({...cfg,coinLaunch:{...cfg.coinLaunch,revision:'v2'},tickets:{...cfg.tickets,mint:'11111111111111111111111111111111'}});
  await expect(quoteCoinBuy(0.05)).rejects.toThrow('settings changed');
  expect(mock.build).not.toHaveBeenCalled();
});
it('quotes only the server-selected mint and checks the revision after building', async () => {
  const q=await quoteCoinBuy(0.05);
  expect(mock.build).toHaveBeenCalledWith(cfg.tickets,wallet.publicKey.toBase58(),0.05);
  expect(q.mint).toBe(mint);
  expect(mock.api).toHaveBeenLastCalledWith('/api/coin/preflight',{mint,coinRevision:'v1',purpose:'coin'});
});
it('an expired quote never opens a wallet or sends a transaction', async () => {
  await expect(approveCoinBuy({...quote(),expires:Date.now()-1},vi.fn())).rejects.toThrow('expired');
  expect(mock.sign).not.toHaveBeenCalled(); expect(mock.send).not.toHaveBeenCalled();
});

it('invalid amounts fail before config reads or wallet initialization', async () => {
  for (const sol of [NaN, 0, 0.0001, 11]) await expect(quoteCoinBuy(sol)).rejects.toThrow('between');
  expect(mock.api).not.toHaveBeenCalled(); expect(mock.payer).not.toHaveBeenCalled();
});

it('a cancelled wallet approval never broadcasts or retries signing', async () => {
  mock.sign.mockRejectedValue(new Error('User cancelled'));
  await expect(approveCoinBuy(quote(), vi.fn())).rejects.toThrow('cancelled');
  expect(mock.sign).toHaveBeenCalledOnce(); expect(mock.send).not.toHaveBeenCalled();
});

it('a wallet receipt closed after quote expiry can send the same signed limits after fresh chain/cost checks', async () => {
  const q = quote();
  mock.sign.mockImplementation(async (tx: Transaction) => {
    tx.partialSign(wallet); q.expires = Date.now() - 1;
    return new Uint8Array(tx.serialize());
  });
  mock.send.mockResolvedValue('rpc-response');
  mock.statuses.mockResolvedValue({ value: [{ err: null, confirmationStatus: 'confirmed' }] });
  await expect(approveCoinBuy(q, vi.fn())).resolves.toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  expect(mock.sign).toHaveBeenCalledOnce(); expect(mock.send).toHaveBeenCalledOnce();
  expect(Connection.prototype.isBlockhashValid).toHaveBeenCalledWith(mint, { commitment: 'confirmed' });
  expect(Connection.prototype.simulateTransaction).toHaveBeenCalledTimes(2);
  expect(Connection.prototype.simulateTransaction).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ sigVerify: true }));
});
it('a launch pause during wallet approval prevents broadcasting the signed transaction', async () => {
  mock.sign.mockImplementation(async (tx:Transaction)=>{tx.partialSign(wallet);return new Uint8Array(tx.serialize());});
  mock.api.mockResolvedValue({ok:true}).mockResolvedValueOnce({ok:true}).mockResolvedValueOnce({ok:true}).mockRejectedValueOnce(new Error('Launch paused'));
  await expect(approveCoinBuy(quote(),vi.fn())).rejects.toThrow('Launch paused');
  expect(mock.sign).toHaveBeenCalledOnce(); expect(mock.send).not.toHaveBeenCalled();
});
it('insufficient SOL stops before asking for approval', async () => {
  vi.spyOn(Connection.prototype,'getBalance').mockResolvedValue(1000);
  await expect(approveCoinBuy(quote(),vi.fn())).rejects.toThrow('0.01 SOL');
  expect(mock.sign).not.toHaveBeenCalled(); expect(mock.send).not.toHaveBeenCalled();
});

it('a failed additional cost review prevents wallet signing and submission', async () => {
  const review = vi.fn().mockRejectedValue(new Error('Test spending limit exceeded'));
  await expect(approveCoinBuy(quote(), vi.fn(), review)).rejects.toThrow('spending limit');
  expect(review).toHaveBeenCalledOnce();
  expect(mock.sign).not.toHaveBeenCalled(); expect(mock.send).not.toHaveBeenCalled();
});

it('a confirmed coin purchase broadcasts once and reports the actual signed transaction ID', async () => {
  mock.sign.mockImplementation(async (tx:Transaction)=>{tx.partialSign(wallet);return new Uint8Array(tx.serialize());});
  mock.api.mockResolvedValue({ok:true}); mock.send.mockResolvedValue('rpc-response');
  mock.statuses.mockResolvedValue({value:[{err:null,confirmationStatus:'confirmed'}]});
  const signature=await approveCoinBuy(quote(),vi.fn());
  expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  expect(mock.send).toHaveBeenCalledOnce();
  expect(mock.api).toHaveBeenCalledTimes(4);
});

it('an expired Solana blockhash after approval never broadcasts or signs another transaction', async () => {
  mock.sign.mockImplementation(async (tx: Transaction) => { tx.partialSign(wallet); return new Uint8Array(tx.serialize()); });
  vi.mocked(Connection.prototype.isBlockhashValid).mockResolvedValue({ context: { slot: 1 }, value: false });
  await expect(approveCoinBuy(quote(), vi.fn())).rejects.toThrow('Solana transaction expired');
  expect(mock.sign).toHaveBeenCalledOnce(); expect(mock.send).not.toHaveBeenCalled();
});

it('failed signed simulation stops broadcasting even though wallet approval succeeded', async () => {
  mock.sign.mockImplementation(async (tx: Transaction) => { tx.partialSign(wallet); return new Uint8Array(tx.serialize()); });
  vi.mocked(Connection.prototype.simulateTransaction).mockResolvedValueOnce({ context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ lamports: 950_000_000 } as any] } }).mockResolvedValueOnce({ context: { slot: 1 }, value: { err: { InstructionError: [1, 'Custom'] } as any, logs: [] } });
  await expect(approveCoinBuy(quote(), vi.fn())).rejects.toThrow('could not be simulated');
  expect(mock.send).not.toHaveBeenCalled();
});

it('a changed signed transaction is refused before simulation or broadcast', async () => {
  // A real wallet gets serialized bytes; make the fixture change a copy instead of the original.
  mock.sign.mockImplementation(async (tx: Transaction) => {
    const changed = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    changed.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(mint), lamports: 1 }));
    changed.partialSign(wallet); return new Uint8Array(changed.serialize());
  });
  await expect(approveCoinBuy(quote(), vi.fn())).rejects.toThrow('changed or invalid');
  expect(mock.send).not.toHaveBeenCalled();
});

it('a pause while the signed transaction is simulated prevents its broadcast', async () => {
  mock.sign.mockImplementation(async (tx: Transaction) => { tx.partialSign(wallet); return new Uint8Array(tx.serialize()); });
  mock.api.mockResolvedValue({ ok: true }).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('Launch paused'));
  await expect(approveCoinBuy(quote(), vi.fn())).rejects.toThrow('Launch paused');
  expect(mock.send).not.toHaveBeenCalled();
});

it('the signed cost must still fit the user’s reviewed total budget', async () => {
  mock.sign.mockImplementation(async (tx: Transaction) => { tx.partialSign(wallet); return new Uint8Array(tx.serialize()); });
  vi.mocked(Connection.prototype.simulateTransaction).mockResolvedValueOnce({ context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ lamports: 950_000_000 } as any] } }).mockResolvedValueOnce({ context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ lamports: 945_000_000 } as any] } });
  const budget = vi.fn(async (_tx, _conn, cost) => { if (cost.totalLamports > 52_000_000) throw new Error('Reviewed budget exceeded'); });
  await expect(approveCoinBuy(quote(), vi.fn(), budget)).rejects.toThrow('budget exceeded');
  expect(budget).toHaveBeenCalledTimes(2); expect(mock.send).not.toHaveBeenCalled();
});

it('uncertain submission retains the transaction and blocks another quote while pending', async () => {
  mock.sign.mockImplementation(async (tx:Transaction)=>{tx.partialSign(wallet);return new Uint8Array(tx.serialize());});
  mock.api.mockResolvedValue({ok:true}); mock.send.mockRejectedValue(new Error('RPC disconnected'));
  await expect(approveCoinBuy(quote(),vi.fn())).rejects.toThrow('Submission uncertain');
  mock.api.mockResolvedValue(cfg);
  mock.statuses.mockResolvedValue({value:[{err:null,confirmationStatus:'processed'}]});
  await expect(quoteCoinBuy(0.05)).rejects.toThrow('previous purchase is still pending');
  expect(mock.build).not.toHaveBeenCalled();
  expect(mock.send).toHaveBeenCalledOnce();
});
