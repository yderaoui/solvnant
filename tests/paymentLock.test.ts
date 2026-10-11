import { afterEach, expect, it, vi } from 'vitest';
import { withPaymentLock } from '../src/client/paymentLock';
afterEach(() => vi.unstubAllGlobals());
it('blocks overlapping wallet approvals and unlocks after failure', async () => {
  let finish!: () => void;
  const first = withPaymentLock('fixture', () => new Promise<void>(resolve => { finish = resolve; }));
  await expect(withPaymentLock('fixture', async () => 1)).rejects.toThrow('Finish your current payment');
  finish(); await first;
  await expect(withPaymentLock('fixture', async () => { throw new Error('Cancelled'); })).rejects.toThrow('Cancelled');
  expect(await withPaymentLock('fixture', async () => 2)).toBe(2);
});
it('refuses a payment when another tab owns the account lock', async () => {
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_key, _options, callback) => callback(null)) } });
  const send = vi.fn();
  await expect(withPaymentLock('fixture', send)).rejects.toThrow('another tab');
  expect(send).not.toHaveBeenCalled();
});
