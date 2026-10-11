import { beforeEach, afterEach, expect, it, vi } from 'vitest';

let upstream;
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('RPC_PROXY_KEY', 'fixture-server-key');
  vi.stubEnv('SOLANA_UPSTREAM_MAINNET', 'https://mainnet.fixture');
  upstream = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: true } })));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function request(method, headers = {}) {
  const { default: handler } = await import('../api/solana-rpc.js');
  const result = { code: 200, body: null };
  const response = {
    status(code) { result.code = code; return this; },
    setHeader() { return this; },
    json(body) { result.body = body; return this; },
    send(body) { result.body = JSON.parse(body); return this; },
    end() { return this; },
  };
  await handler({ method: 'POST', headers: { origin: 'https://www.pumpkart.racing', ...headers }, query: { cluster: 'mainnet-beta' }, body: { jsonrpc: '2.0', id: 1, method, params: ['fixture-blockhash', { commitment: 'confirmed' }] } }, response);
  return result;
}
it('allows browser transaction-lifetime checks on the configured mainnet proxy without server credentials', async () => {
  const result = await request('isBlockhashValid');
  expect(result.code).toBe(200);
  expect(result.body.result.value).toBe(true);
  expect(upstream).toHaveBeenCalledWith('https://mainnet.fixture', expect.objectContaining({ method: 'POST' }));
  expect(JSON.parse(upstream.mock.calls[0][1].body)).toMatchObject({ method: 'isBlockhashValid', params: ['fixture-blockhash', { commitment: 'confirmed' }] });
});
it('keeps transaction-detail reads restricted to the server', async () => {
  expect((await request('getTransaction')).code).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
});
it('still allows authenticated server transaction verification', async () => {
  expect((await request('getTransaction', { 'x-rpc-key': 'fixture-server-key' })).code).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
});
it('refuses unlisted browser methods instead of forwarding them', async () => {
  expect((await request('getProgramAccounts')).code).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
});
