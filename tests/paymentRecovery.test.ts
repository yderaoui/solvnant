import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn(), wallet: vi.fn() }));
vi.mock('@solana/spl-token', async original => ({ ...await original<object>(), getMint: async () => ({ decimals: 6 }) }));
vi.mock('../src/client/account', () => ({ account: { me: { id: 'alice' }, cfg: { tickets: {} }, api: mocks.api, refresh: mocks.refresh } }));
vi.mock('../src/client/privy/client', () => ({ privyOn: () => true, privyWallet: mocks.wallet }));
import { account } from '../src/client/account';
import { buyTicket, claimPendingTicket, withdrawCoins } from '../src/client/tickets';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';

let store: Map<string, string>;
beforeEach(() => {
  vi.clearAllMocks();
  store = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) });
  account.me = { id: 'alice' } as typeof account.me;
  account.cfg = { tickets: {} } as typeof account.cfg;
  mocks.refresh.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['The game server is not reachable.', 'Server error 503', 'Not authorized.', 'This payment is not for this account (memo mismatch).'])('keeps a paid receipt after %s', async error => {
  store.set('tl-pending-ticket:alice', 'public-signature');
  mocks.api.mockRejectedValue(new Error(error));
  expect(await claimPendingTicket()).toBe(false);
  expect(store.get('tl-pending-ticket:alice')).toBe('public-signature');
});
it('does not attempt to claim another account’s scoped receipt', async () => {
  store.set('tl-pending-ticket:bob', 'bob-signature');
  expect(await claimPendingTicket()).toBe(false);
  expect(mocks.api).not.toHaveBeenCalled();
  expect(store.get('tl-pending-ticket:bob')).toBe('bob-signature');
});
it('recovers an old unscoped receipt and clears it only after crediting', async () => {
  store.set('tl-pending-ticket', 'legacy-signature');
  mocks.api.mockResolvedValue({ ok: true });
  mocks.refresh.mockRejectedValue(new Error('Connection lost after crediting'));
  expect(await claimPendingTicket()).toBe(true);
  expect(store.has('tl-pending-ticket')).toBe(false);
});
it('blocks a second payment while the earlier transaction is pending, without opening a wallet', async () => {
  store.set('tl-pending-ticket:alice', 'pending-signature');
  mocks.api.mockResolvedValue({ ok: false, pending: true });
  await expect(buyTicket(vi.fn())).rejects.toThrow('Do not pay again');
  expect(mocks.wallet).not.toHaveBeenCalled();
  expect(mocks.api).toHaveBeenCalledTimes(1);
});
it('returns an earlier credited ticket when the player retries, without charging again', async () => {
  store.set('tl-pending-ticket:alice', 'credited-signature');
  mocks.api.mockResolvedValue({ ok: true, tickets: 2 });
  expect(await buyTicket(vi.fn())).toBe(2);
  expect(mocks.wallet).not.toHaveBeenCalled();
  expect(store.has('tl-pending-ticket:alice')).toBe(false);
});
it('blocks overlapping checkout attempts while an earlier receipt is being checked', async () => {
  store.set('tl-pending-ticket:alice', 'pending-signature');
  let finish!: (value: object) => void;
  mocks.api.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = buyTicket(vi.fn());
  await expect(buyTicket(vi.fn())).rejects.toThrow('Finish your current payment');
  finish({ ok: true, tickets: 1 });
  expect(await first).toBe(1);
  expect(mocks.wallet).not.toHaveBeenCalled();
});
it('unlocks an expired purchase only after finalized height and historical status confirm it never landed', async () => {
  store.set('tl-pending-ticket:alice', JSON.stringify({ signature: 'expired-signature', rpcUrl: 'https://rpc.fixture', lastValidBlockHeight: 100 }));
  mocks.api.mockResolvedValue({ ok: false, pending: true });
  vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockResolvedValue({ context: { slot: 1 }, value: [null] });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: 111 }))));
  expect(await claimPendingTicket()).toBe(false);
  expect(mocks.api).toHaveBeenCalledWith('/api/ticket/claim', { signature: 'expired-signature' });
  expect(store.has('tl-pending-ticket:alice')).toBe(false);
});
it('discards a definitively failed scoped transaction but preserves legacy receipts', async () => {
  store.set('tl-pending-ticket:alice', 'failed-signature');
  store.set('tl-pending-skin', 'legacy-signature');
  mocks.api.mockRejectedValue(new Error('The payment transaction failed on-chain.'));
  await claimPendingTicket();
  expect(store.has('tl-pending-ticket:alice')).toBe(false);
  expect(store.get('tl-pending-skin')).toBe('legacy-signature');
});

function withdrawalReceipt() {
  store.set('tl-pending-withdrawal:alice', JSON.stringify({ signature: 'withdrawal-signature', rpcUrl: 'https://rpc.fixture', lastValidBlockHeight: 100 }));
}
it('keeps an uncertain withdrawal and checks it without asking for another signature', async () => {
  withdrawalReceipt();
  vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockRejectedValue(new Error('RPC offline'));
  expect(await withdrawCoins('', 0, vi.fn())).toEqual({ signature: 'withdrawal-signature', confirmed: false });
  expect(store.has('tl-pending-withdrawal:alice')).toBe(true);
  expect(mocks.wallet).not.toHaveBeenCalled();
});
it('confirms a previous withdrawal without sending again', async () => {
  withdrawalReceipt();
  vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockResolvedValue({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
  expect(await withdrawCoins('', 0, vi.fn())).toEqual({ signature: 'withdrawal-signature', confirmed: true });
  expect(store.has('tl-pending-withdrawal:alice')).toBe(false);
  expect(mocks.wallet).not.toHaveBeenCalled();
});
it('unlocks an expired withdrawal only after finalized chain height and history prove it did not land', async () => {
  withdrawalReceipt();
  const status = vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockResolvedValue({ context: { slot: 1 }, value: [null] });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: 111 }))));
  await expect(withdrawCoins('', 0, vi.fn())).rejects.toThrow('expired');
  expect(status).toHaveBeenCalledWith(['withdrawal-signature'], { searchTransactionHistory: true });
  expect(store.has('tl-pending-withdrawal:alice')).toBe(false);
  expect(mocks.wallet).not.toHaveBeenCalled();
});

it('saves the withdrawal signature before broadcasting and never signs twice after an uncertain send', async () => {
  const player = Keypair.generate(); // Disposable unfunded fixture, never sent to a network.
  const mint = 'So11111111111111111111111111111111111111112';
  account.cfg = { ...account.cfg!, tickets: { mint, treasury: mint, decimals: 6, price: 1, cluster: 'devnet', symbol: '$TEST', rpcUrl: 'https://rpc.fixture' } };
  const sign = vi.fn(async bytes => {
    const tx = Transaction.from(bytes);
    tx.partialSign(player);
    return new Uint8Array(tx.serialize());
  });
  mocks.wallet.mockResolvedValue({ address: player.publicKey.toBase58(), sign });
  vi.spyOn(Connection.prototype, 'getAccountInfo').mockImplementation(async address => address.toBase58() === mint ? { owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: Buffer.alloc(82), executable: false, lamports: 1, rentEpoch: 1 } : null);
  vi.spyOn(Connection.prototype, 'getTokenAccountBalance').mockResolvedValue({ context: { slot: 1 }, value: { amount: '10000000', decimals: 6, uiAmount: 10, uiAmountString: '10' } });
  vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({ blockhash: mint, lastValidBlockHeight: 100 });
  const send = vi.spyOn(Connection.prototype, 'sendRawTransaction').mockImplementation(async () => {
    expect(store.has('tl-pending-withdrawal:alice')).toBe(true);
    throw new Error('RPC response lost');
  });
  const statuses = vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockRejectedValue(new Error('Network offline'));
  const pending = await withdrawCoins(mint, 1, vi.fn());
  expect(pending.confirmed).toBe(false);
  expect(pending.signature.length).toBeGreaterThan(60);
  statuses.mockResolvedValue({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
  expect(await withdrawCoins(mint, 1, vi.fn())).toEqual({ signature: pending.signature, confirmed: true });
  expect(sign).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
});
