import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const saved = new Map<string, string>();
const request = vi.fn();
const cfg = { privy: 'fixture-app', points: { signup: 1000 } };
const me = { id: 'privy:fixture', kind: 'privy', name: 'Fixture', points: 1000 };

beforeEach(() => {
  vi.resetModules(); request.mockReset(); saved.clear();
  saved.set('tl-token', 'fixture-existing-session');
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  vi.stubGlobal('fetch', request);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps an existing login through a connection failure and recovers on retry', async () => {
  request.mockRejectedValueOnce(new TypeError('Network unavailable'))
    .mockResolvedValueOnce(Response.json({ error: 'Try again' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json(cfg))
    .mockResolvedValueOnce(Response.json(me));
  const { account } = await import('../src/client/account');
  await account.load();
  expect(account.cfg).toBeNull(); expect(account.me).toBeNull();
  expect(saved.get('tl-token')).toBe('fixture-existing-session');
  await account.load();
  expect(account.cfg).toEqual(cfg); expect(account.me).toEqual(me);
  expect(account.token).toBe('fixture-existing-session');
  expect(request).toHaveBeenCalledTimes(4);
});

it('bounds a stuck session request so the player can retry', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  request.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Aborted')));
  }));
  const { account } = await import('../src/client/account');
  const result = expect(account.api('/api/me')).rejects.toThrow('not reachable');
  await vi.advanceTimersByTimeAsync(12_000); await result;
  expect(timeout).toHaveBeenCalledWith(12_000);
  expect(account.token).toBe('fixture-existing-session');
  timeout.mockRestore();
});

it('notifies the UI when settings recover even without a coin revision', async () => {
  request.mockResolvedValueOnce(Response.json(cfg)).mockResolvedValueOnce(Response.json(me));
  const { account } = await import('../src/client/account');
  const changed = vi.fn(); account.onChange(changed);
  await account.refreshConfig();
  expect(account.cfg).toEqual(cfg); expect(account.me).toEqual(me);
  expect(changed).toHaveBeenCalled();
});

it('clears only an expired session, and does not automatically retry a payment', async () => {
  request.mockResolvedValueOnce(Response.json(cfg))
    .mockResolvedValueOnce(Response.json({ error: 'Expired session' }, { status: 401 }))
    .mockRejectedValueOnce(new TypeError('Network unavailable'));
  const { account } = await import('../src/client/account');
  await account.load();
  expect(account.token).toBeNull(); expect(saved.has('tl-token')).toBe(false);
  await expect(account.api('/api/ticket/claim', { signature: 'fixture' })).rejects.toThrow('not reachable');
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls[2][1].signal).toBeUndefined();
});
