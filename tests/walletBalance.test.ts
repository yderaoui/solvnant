import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ fetch: vi.fn(), wallet: vi.fn() }));
vi.mock('../src/client/account', () => ({ account: { cfg: { tickets: { rpcUrl: 'https://rpc.fixture', mint: 'fixture-mint' } } } }));
vi.mock('../src/client/privy/client', () => ({ privyWallet: mock.wallet }));
import { coinBalance } from '../src/client/tickets';

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', mock.fetch);
  mock.wallet.mockResolvedValue({ address: 'fixture-wallet' });
});
afterEach(() => vi.unstubAllGlobals());

it('does not report a zero balance when the RPC fails', async () => {
  mock.fetch.mockResolvedValue({ ok: true, json: async () => ({ error: { message: 'upstream unavailable' } }) });
  await expect(coinBalance()).rejects.toThrow('unavailable');
});
it('allows a real empty token-account result to show zero', async () => {
  mock.fetch.mockResolvedValue({ ok: true, json: async () => ({ result: { value: [] } }) });
  await expect(coinBalance()).resolves.toBe(0);
});
it('passes the cancellation signal to the balance request', async () => {
  const controller = new AbortController(); controller.abort();
  mock.fetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
  await expect(coinBalance(controller.signal)).rejects.toThrow('Aborted');
  expect(mock.fetch).toHaveBeenCalledWith('https://rpc.fixture', expect.objectContaining({ signal: controller.signal }));
});
