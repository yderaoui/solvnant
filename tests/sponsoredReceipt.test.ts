import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Hub } from '../src/game/hub';
import { signSession } from '../src/game/auth';

const mocks = vi.hoisted(() => ({ cosign: vi.fn(), send: vi.fn() }));
vi.mock('../src/game/house', async original => ({
  ...await original<object>(),
  loadHouse: async () => ({ address: '11111111111111111111111111111111' }),
  cosignPurchase: mocks.cosign, cosignWithdrawal: mocks.cosign, sendWire: mocks.send,
}));
const env = {
  SESSION_SECRET: 'fixture-session-only', HOUSE_SECRET: 'mocked-not-a-key',
  TICKET_CLUSTER: 'devnet', TICKET_MINT: 'So11111111111111111111111111111111111111112',
  TICKET_TREASURY: '11111111111111111111111111111111', TICKET_PRICE: '1',
  COIN_LAUNCH_READY: 'true', COIN_LAUNCH_REVISION: 'fixture-revision',
};
let db: DatabaseSync, hub: Hub;
beforeEach(() => {
  vi.clearAllMocks();
  db = new DatabaseSync(':memory:');
  hub = new Hub({ storage: {
    sql: { exec(query: string, ...args: unknown[]) {
      const s = db.prepare(query);
      const values = args as (string | number | null)[];
      const rows = s.columns().length ? s.all(...values) : (s.run(...values), []);
      return { toArray: () => rows, one: () => rows[0] };
    } },
    transactionSync: fn => fn(), getAlarm: async () => Date.now() + 60_000, setAlarm: async () => {},
  } }, env);
  mocks.cosign.mockResolvedValue({ signature: 'public-fixture-signature', wire: 'fixture-wire-not-broadcast' });
  mocks.send.mockRejectedValue(new Error('RPC lost response after accepting the transaction'));
});
afterEach(() => db.close());
async function post(path: string) {
  const token = await signSession({ uid: 'fixture-player', kind: 'guest', name: 'Fixture' }, env.SESSION_SECRET);
  return hub.fetch(new Request(`https://fixture${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ tx: 'fixture-partial-transaction', coinRevision: env.COIN_LAUNCH_REVISION }) }));
}
it.each(['/api/pay/sponsor', '/api/pay/withdraw'])('returns the persisted signature after an uncertain broadcast at %s', async path => {
  const r = await post(path);
  expect(r.status).toBe(202);
  expect(await r.json()).toEqual({ ok: true, pending: true, signature: 'public-fixture-signature' });
  expect(db.prepare('SELECT sig,uid FROM sponsored').all()).toEqual([{ sig: 'public-fixture-signature', uid: 'fixture-player' }]);
});
it.each(['/api/pay/sponsor', '/api/pay/withdraw'])('refuses invalid instructions before broadcasting at %s', async path => {
  mocks.cosign.mockRejectedValue(new Error('Invalid instructions'));
  expect((await post(path)).status).toBe(400);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(db.prepare('SELECT sig FROM sponsored').all()).toEqual([]);
});
