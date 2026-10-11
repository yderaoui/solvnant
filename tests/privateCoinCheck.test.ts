import { beforeEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PRIVATE_BUY_CHECK, privateBuyMessage, validPrivateBuyProof, PROOF_LIFETIME } from '../src/game/privateBuyCheck';
import handler from '../api/private-coin-check';
const mock = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/game/solana', async importOriginal => {
  const original = await importOriginal<typeof import('../src/game/solana')>();
  return { ...original, verifyWalletSignature: mock.verify };
});
const fixture = generateKeyPairSync('ed25519'); // Ephemeral fixture, never funded or persisted.
const now = Date.parse('2026-10-11T17:00:00Z');
const token = 'fixture-session-only';
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const original = await vi.importActual<typeof import('../src/game/solana')>('../src/game/solana');
  const fixtureAddress = original.base58Encode(new Uint8Array(fixture.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)));
  mock.verify.mockImplementation(async (address, message, signature) => address === PRIVATE_BUY_CHECK.wallet && original.verifyWalletSignature(fixtureAddress, message, signature));
  fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
});
async function proof(timestamp = now, boundToken = token) {
  return { timestamp, signature: sign(null, Buffer.from(await privateBuyMessage(boundToken, timestamp)), fixture.privateKey).toString('base64') };
}
async function call(body: unknown, options: { token?: string | null; origin?: string; method?: string } = {}) {
  let status = 200; let output: any;
  const headers: Record<string, string> = { origin: options.origin ?? 'https://www.pumpkart.racing' };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? token}`;
  const res = { setHeader: vi.fn(), status(n: number) { status = n; return this; }, json(b: unknown) { output = b; } };
  await handler({ method: options.method ?? 'POST', headers, body }, res);
  return { status, output, headers: res.setHeader };
}
it('binds a free ownership signature to the owner wallet and exact game session', async () => {
  const p = await proof();
  expect(await validPrivateBuyProof(token, p, now)).toBe(true);
  expect(await validPrivateBuyProof('different-session', p, now)).toBe(false);
  expect(mock.verify.mock.calls[0][0]).toBe(PRIVATE_BUY_CHECK.wallet);
});
it('rejects forged, expired, future and closed-test proofs', async () => {
  expect(await validPrivateBuyProof(token, { timestamp: now, signature: 'bad' }, now)).toBe(false);
  expect(await validPrivateBuyProof(token, await proof(now - PROOF_LIFETIME), now)).toBe(false);
  expect(await validPrivateBuyProof(token, await proof(now + 30_001), now)).toBe(false);
  expect(await validPrivateBuyProof(token, await proof(), PRIVATE_BUY_CHECK.expiresAt)).toBe(false);
});
it('refuses unauthenticated, cross-origin and unsupported payment requests', async () => {
  expect((await call({ action: 'config' }, { token: null })).status).toBe(401);
  expect((await call({ action: 'config' }, { origin: 'https://attacker.example' })).status).toBe(403);
  expect((await call({ action: 'withdraw' })).status).toBe(400);
  expect((await call({}, { method: 'GET' })).status).toBe(405);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('requires both wallet ownership and a real Privy-backed game session', async () => {
  expect((await call({ action: 'config', proof: { timestamp: now, signature: 'bad' } })).status).toBe(403);
  fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
  expect((await call({ action: 'config', proof: await proof() })).status).toBe(401);
  fetchMock.mockResolvedValue(Response.json({ kind: 'guest', id: 'fixture' }));
  expect((await call({ action: 'config', proof: await proof() })).status).toBe(403);
});
it('returns isolated settings without mutating paused production settings or exposing a sponsor', async () => {
  const production = { coinLaunch: { status: 'paused', buyEnabled: false, revision: 'production' }, tickets: { mint: 'official-fixture' }, sponsor: 'house-fixture', privy: 'app-fixture' };
  fetchMock.mockResolvedValueOnce(Response.json({ kind: 'privy', id: 'privy:fixture' })).mockResolvedValueOnce(Response.json(production));
  const result = await call({ action: 'config', proof: await proof() });
  expect(result.status).toBe(200);
  expect(result.output.coinLaunch.revision).toBe(PRIVATE_BUY_CHECK.revision);
  expect(result.output.tickets.mint).toBe(PRIVATE_BUY_CHECK.mint);
  expect(result.output.sponsor).toBeNull();
  expect(result.headers).toHaveBeenCalledWith('cache-control', 'no-store');
  expect(production.coinLaunch.status).toBe('paused');
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://ai-grand-prix-game.ai-grand-prix.workers.dev/api/me', 'https://ai-grand-prix-game.ai-grand-prix.workers.dev/api/config']);
});
it('preflights only the selected test coin and rejects tickets or stale revisions', async () => {
  fetchMock.mockImplementation(async () => Response.json({ kind: 'privy', id: 'privy:fixture' }));
  const b = { action: 'preflight', proof: await proof(), purpose: 'coin', mint: PRIVATE_BUY_CHECK.mint, coinRevision: PRIVATE_BUY_CHECK.revision };
  expect((await call(b)).status).toBe(200);
  expect((await call({ ...b, purpose: 'ticket' })).status).toBe(409);
  expect((await call({ ...b, mint: 'wrong-coin' })).status).toBe(409);
  expect((await call({ ...b, coinRevision: 'stale' })).status).toBe(409);
});
it('fails closed when session validation cannot be reached', async () => {
  fetchMock.mockRejectedValue(new Error('network unavailable'));
  expect((await call({ action: 'config', proof: await proof() })).status).toBe(503);
});
