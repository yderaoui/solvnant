import { afterEach, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { pumpConnection } from '../src/game/pumpTrade';
import type { TicketConfig } from '../src/game/config';
const t: TicketConfig = { cluster: 'mainnet-beta', rpcUrl: 'https://browser.fixture/rpc?cluster=mainnet-beta', verifyUrl: 'https://server.fixture/api/solana-rpc', verifyKey: 'fixture-proxy-key', mint: '11111111111111111111111111111111', treasury: '11111111111111111111111111111111', decimals: 6, price: 0, symbol: '$FIXTURE' };
afterEach(() => vi.unstubAllGlobals());
it('selects the configured network on server verification reads and preserves proxy authentication', async () => {
  const rpc = vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { context: { slot: 1 }, value: 123 } }));
  });
  vi.stubGlobal('fetch', rpc);
  expect(await pumpConnection(t).getBalance(new PublicKey(t.treasury))).toBe(123);
  const [url, options] = rpc.mock.calls[0];
  expect(new URL(url).searchParams.get('cluster')).toBe('mainnet-beta');
  expect(options.headers).toMatchObject({ 'x-rpc-key': 'fixture-proxy-key' });
  expect(options.signal).toBeInstanceOf(AbortSignal);
});
it('replaces an old cluster value without duplicate parameters, preserving other query options', () => {
  const url = new URL(pumpConnection({ ...t, cluster: 'devnet', verifyUrl: t.verifyUrl + '?cluster=mainnet-beta&option=fixture' }).rpcEndpoint);
  expect(url.searchParams.getAll('cluster')).toEqual(['devnet']);
  expect(url.searchParams.get('option')).toBe('fixture');
});
it('keeps the public browser RPC endpoint when no server verification URL is present', () => {
  expect(pumpConnection({ ...t, verifyUrl: undefined, verifyKey: undefined }).rpcEndpoint).toBe(t.rpcUrl);
});
