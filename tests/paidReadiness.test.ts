import { expect, it, vi } from 'vitest';
import { paidReadinessProblem, PAID_LAUNCH_RESERVE } from '../src/game/paidReadiness';
import type { TicketConfig } from '../src/game/config';
const treasury = 'So11111111111111111111111111111111111111112';
const team = '11111111111111111111111111111111';
const cfg = { treasury, cluster: 'mainnet-beta', rpcUrl: 'https://rpc.fixture', verifyUrl: 'https://proxy.fixture/api/solana-rpc?existing=1', verifyKey: 'fixture-only' } as TicketConfig;
const rpc = (value: unknown) => vi.fn(async () => new Response(JSON.stringify({ result: { value } })));
it('refuses missing/mismatched payout signing and missing team destination before reading balances', async () => {
  const fetchFn = rpc(PAID_LAUNCH_RESERVE);
  expect(await paidReadinessProblem(cfg, null, team, fetchFn)).toContain('payout wallet');
  expect(await paidReadinessProblem(cfg, team, team, fetchFn)).toContain('payout wallet');
  expect(await paidReadinessProblem(cfg, treasury, null, fetchFn)).toContain('team wallet');
  expect(fetchFn).not.toHaveBeenCalled();
});
it.each([0, 890880, PAID_LAUNCH_RESERVE - 1])('refuses an underfunded treasury (%i lamports)', async value => {
  expect(await paidReadinessProblem(cfg, treasury, team, rpc(value))).toContain('at least 0.02 SOL');
});
it('checks the configured chain through the authenticated proxy and accepts the funded reserve', async () => {
  const fetchFn = rpc(PAID_LAUNCH_RESERVE);
  expect(await paidReadinessProblem(cfg, treasury, team, fetchFn)).toBeNull();
  const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.searchParams.get('cluster')).toBe('mainnet-beta');
  expect(url.searchParams.get('existing')).toBe('1');
  expect(init.headers).toMatchObject({ 'x-rpc-key': 'fixture-only' });
  expect(JSON.parse(init.body as string).params).toEqual([treasury, 'confirmed']);
});
it.each([null, -1, '20000000', 1.5])('fails closed when the balance response is malformed (%s)', async value => {
  expect(await paidReadinessProblem(cfg, treasury, team, rpc(value))).toContain('Cannot verify');
});
it('fails closed on RPC/network errors', async () => {
  const fetchFn = vi.fn().mockRejectedValue(new Error('Network timeout'));
  expect(await paidReadinessProblem(cfg, treasury, team, fetchFn)).toContain('stay paused');
});
