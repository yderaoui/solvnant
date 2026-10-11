import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn(), wallet: vi.fn() }));
vi.mock('@solana/spl-token', async original => ({ ...await original<object>(), getMint: async () => ({ decimals: 6 }) }));
vi.mock('../src/client/account', () => ({ account: { me: { id: 'alice' }, cfg: { tickets: {} }, api: mocks.api, refresh: mocks.refresh } }));
vi.mock('../src/client/privy/client', () => ({ privyOn: () => true, privyWallet: mocks.wallet }));
import { account } from '../src/client/account';
import { buyTicket, claimPendingTicket, withdrawCoins } from '../src/client/tickets';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { base58Encode } from '../src/game/solana';

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

function sponsoredFixture() {
  const player = Keypair.generate(), house = Keypair.generate(), destination = Keypair.generate().publicKey;
  const mint = 'So11111111111111111111111111111111111111112';
  const tickets = { mint, treasury: house.publicKey.toBase58(), decimals: 6, price: 1, cluster: 'devnet' as const, symbol: '$TEST', rpcUrl: 'https://rpc.fixture' };
  account.cfg = { ...account.cfg!, sponsor: house.publicKey.toBase58(), tickets } as typeof account.cfg;
  const sign = vi.fn(async bytes => {
    const tx = Transaction.from(bytes); tx.partialSign(player);
    return new Uint8Array(tx.serialize({ requireAllSignatures: false }));
  });
  mocks.wallet.mockResolvedValue({ address: player.publicKey.toBase58(), sign });
  vi.spyOn(Connection.prototype, 'getAccountInfo').mockResolvedValue({ owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: Buffer.alloc(82), executable: false, lamports: 1, rentEpoch: 1 });
  vi.spyOn(Connection.prototype, 'getTokenAccountBalance').mockResolvedValue({ context: { slot: 1 }, value: { amount: '10000000', decimals: 6, uiAmount: 10, uiAmountString: '10' } });
  vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({ blockhash: mint, lastValidBlockHeight: 100 });
  vi.spyOn(Connection.prototype, 'isBlockhashValid').mockResolvedValue({ context: { slot: 1 }, value: true });
  const prepare = (body: { tx: string; prepareOnly?: boolean }) => {
    expect(body.prepareOnly).toBe(true);
    const tx = Transaction.from(Buffer.from(body.tx, 'base64')); tx.partialSign(house);
    return { signature: base58Encode(new Uint8Array(tx.signature!)), wire: tx.serialize().toString('base64') };
  };
  return { sign, destination: destination.toBase58(), tickets, prepare };
}
it('persists a sponsored withdrawal before broadcast and checks the same ID after an uncertain send', async () => {
  const fixture = sponsoredFixture();
  mocks.api.mockImplementation(async (_path, body) => fixture.prepare(body));
  const send = vi.spyOn(Connection.prototype, 'sendRawTransaction').mockImplementation(async () => {
    expect(store.has('tl-pending-withdrawal:alice')).toBe(true); throw new Error('response lost');
  });
  const statuses = vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockRejectedValue(new Error('RPC offline'));
  const r = await withdrawCoins(fixture.destination, 1, vi.fn()); expect(r.confirmed).toBe(false);
  statuses.mockResolvedValue({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
  expect(await withdrawCoins('', 0, vi.fn())).toEqual({ signature: r.signature, confirmed: true });
  expect(fixture.sign).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce(); expect(mocks.api).toHaveBeenCalledOnce();
});
it('a lost sponsorship preparation response does not broadcast a withdrawal', async () => {
  const fixture = sponsoredFixture(); mocks.api.mockRejectedValue(new Error('Response lost'));
  const send = vi.spyOn(Connection.prototype, 'sendRawTransaction');
  await expect(withdrawCoins(fixture.destination, 1, vi.fn())).rejects.toThrow('Response lost');
  expect(send).not.toHaveBeenCalled(); expect(store.has('tl-pending-withdrawal:alice')).toBe(false);
});
it('persists a sponsored entry ID before sending and claims it without a second approval', async () => {
  const fixture = sponsoredFixture();
  mocks.api.mockImplementation(async (path, body) => path === '/api/ticket/intent' ? { ...fixture.tickets, memo: 'PumpKart ticket fixture' } : path === '/api/pay/sponsor' ? fixture.prepare(body) : path === '/api/ticket/claim' ? { ok: true, tickets: 1 } : {});
  const send = vi.spyOn(Connection.prototype, 'sendRawTransaction').mockImplementation(async () => {
    expect(store.has('tl-pending-ticket:alice')).toBe(true); throw new Error('response lost');
  });
  expect(await buyTicket(vi.fn())).toBe(1);
  expect(fixture.sign).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce(); expect(store.has('tl-pending-ticket:alice')).toBe(false);
});
it('an account change during withdrawal approval never prepares or broadcasts it', async () => {
  const fixture = sponsoredFixture();
  const sign = fixture.sign.getMockImplementation()!;
  fixture.sign.mockImplementation(async bytes => { const r = await sign(bytes); account.me = { id: 'bob' } as typeof account.me; return r; });
  const send = vi.spyOn(Connection.prototype, 'sendRawTransaction');
  await expect(withdrawCoins(fixture.destination, 1, vi.fn())).rejects.toThrow('Account or coin changed');
  expect(mocks.api).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});
it('rejects a withdrawal expired during wallet approval before sponsorship or broadcast', async () => {
  const fixture = sponsoredFixture();
  vi.mocked(Connection.prototype.isBlockhashValid).mockResolvedValue({ context: { slot: 1 }, value: false });
  const send = vi.spyOn(Connection.prototype, 'sendRawTransaction');
  await expect(withdrawCoins(fixture.destination, 2, vi.fn())).rejects.toThrow('transaction expired');
  expect(mocks.api).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(store.has('tl-pending-withdrawal:alice')).toBe(false);
});
it('exposes the receipt before broadcast rather than hiding it until confirmation finishes', async () => {
  const fixture = sponsoredFixture(); mocks.api.mockImplementation(async (_path, body) => fixture.prepare(body));
  const receipt = vi.fn();
  vi.spyOn(Connection.prototype, 'sendRawTransaction').mockImplementation(async () => { expect(receipt).toHaveBeenCalledOnce(); return 'fixture'; });
  vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockRejectedValue(new Error('RPC offline'));
  const r = await withdrawCoins(fixture.destination, 2, vi.fn(), receipt);
  expect(receipt).toHaveBeenCalledWith(r.signature); expect(r.confirmed).toBe(false);
});
it('bounds an unavailable withdrawal status read and retains its receipt for checking', async () => {
  vi.useFakeTimers(); withdrawalReceipt();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal;
  });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('RPC timed out')));
  })));
  try {
    const receipt = vi.fn(); const pending = withdrawCoins('', 0, vi.fn(), receipt);
    await vi.advanceTimersByTimeAsync(8_100);
    expect(await pending).toEqual({ signature: 'withdrawal-signature', confirmed: false });
    expect(receipt).toHaveBeenCalledWith('withdrawal-signature'); expect(store.has('tl-pending-withdrawal:alice')).toBe(true);
    expect(mocks.wallet).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
it('re-broadcasts only the exact saved withdrawal wire without a second wallet approval', async () => {
  const fixture = sponsoredFixture(); mocks.api.mockImplementation(async (_path, body) => fixture.prepare(body));
  const send = vi.spyOn(Connection.prototype, 'sendRawTransaction').mockResolvedValue('fixture');
  const statuses = vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockRejectedValue(new Error('RPC offline'));
  const first = await withdrawCoins(fixture.destination, 2, vi.fn());
  const receipt = JSON.parse(store.get('tl-pending-withdrawal:alice')!); expect(receipt.wire).toEqual(expect.any(String));
  statuses.mockResolvedValue({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 0, err: null, confirmationStatus: 'processed' }] });
  expect(await withdrawCoins('', 0, vi.fn())).toEqual(first);
  expect(send).toHaveBeenCalledTimes(2);
  expect(new Uint8Array(send.mock.calls[0][0])).toEqual(new Uint8Array(send.mock.calls[1][0]));
  statuses.mockResolvedValue({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
  expect(await withdrawCoins('', 0, vi.fn())).toEqual({ signature: first.signature, confirmed: true });
  expect(fixture.sign).toHaveBeenCalledOnce(); expect(mocks.api).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledTimes(2);
});
