import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PrivyState } from '../src/client/privy/island';

const mock = vi.hoisted(() => ({ mount: vi.fn(), notify: null as ((s: PrivyState) => void) | null }));
vi.mock('../src/client/account', () => ({ account: { cfg: { privy: 'fixture-app', tickets: { cluster: 'mainnet-beta' } }, me: { id: 'fixture' } } }));
vi.mock('../src/client/privy/island', () => ({ mountPrivy: mock.mount }));

const wallet = { address: 'So11111111111111111111111111111111111111112', embedded: true, sign: vi.fn(), signAndSend: vi.fn() };
const state = (overrides: Partial<PrivyState> = {}): PrivyState => ({
  ready: true, authenticated: true, user: null, wallet: null,
  login: vi.fn(), logout: vi.fn(), getAccessToken: vi.fn(), ...overrides,
});
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks(); mock.notify = null;
  mock.mount.mockImplementation((_app, _chain, notify) => { mock.notify = notify; });
});
afterEach(() => { vi.useRealTimers(); });

it('times out even when the authentication SDK never becomes ready', async () => {
  const { privyWallet } = await import('../src/client/privy/client');
  const result = expect(privyWallet(1000)).rejects.toThrow('could not finish loading');
  await vi.advanceTimersByTimeAsync(1000); await result;
});

it('includes SDK initialization in the wallet deadline', async () => {
  const { privyWallet } = await import('../src/client/privy/client');
  const result = expect(privyWallet(1000)).rejects.toThrow('still being created');
  await vi.advanceTimersByTimeAsync(800); mock.notify!(state());
  await vi.advanceTimersByTimeAsync(200); await result;
});

it('can retry after a timeout and reuses the same existing wallet', async () => {
  const { privyWallet } = await import('../src/client/privy/client');
  const failure = expect(privyWallet(1000)).rejects.toThrow('could not finish loading');
  await vi.advanceTimersByTimeAsync(1000); await failure;
  mock.notify!(state({ wallet }));
  await expect(privyWallet(1000)).resolves.toBe(wallet);
  await expect(privyWallet(1000)).resolves.toBe(wallet);
  expect(mock.mount).toHaveBeenCalledTimes(1);
});

it('stops waiting when the player signs out', async () => {
  const { privyWallet } = await import('../src/client/privy/client');
  const failure = expect(privyWallet(1000)).rejects.toThrow('Sign in first');
  await vi.advanceTimersByTimeAsync(0); mock.notify!(state());
  await vi.advanceTimersByTimeAsync(0); mock.notify!(state({ authenticated: false }));
  await vi.advanceTimersByTimeAsync(300); await failure;
});

it('retries mounting after a failed SDK load', async () => {
  mock.mount.mockImplementationOnce(() => { throw new Error('SDK load failed'); });
  const { privyWallet } = await import('../src/client/privy/client');
  await expect(privyWallet(1000)).rejects.toThrow('SDK load failed');
  const retry = privyWallet(1000);
  await vi.advanceTimersByTimeAsync(0); mock.notify!(state({ wallet }));
  await expect(retry).resolves.toBe(wallet);
  expect(mock.mount).toHaveBeenCalledTimes(2);
});
