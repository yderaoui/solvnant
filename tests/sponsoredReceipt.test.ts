import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Hub } from '../src/game/hub';
import { signSession } from '../src/game/auth';

const mocks = vi.hoisted(() => ({ cosign: vi.fn(), send: vi.fn(), status: vi.fn(), height: vi.fn(), build: vi.fn(), alarm: vi.fn(), deleteAlarm: vi.fn(), getAlarm: vi.fn() }));
vi.mock('../src/game/house', async original => ({
  ...await original<object>(),
  loadHouse: async () => ({ address: '11111111111111111111111111111111' }),
  cosignPurchase: mocks.cosign, cosignWithdrawal: mocks.cosign, sendWire: mocks.send,
  txStatus: mocks.status, blockHeight: mocks.height, buildPayout: mocks.build,
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
    transactionSync: fn => fn(), getAlarm: mocks.getAlarm, setAlarm: mocks.alarm, deleteAlarm: mocks.deleteAlarm,
  } }, env);
  mocks.cosign.mockResolvedValue({ signature: 'public-fixture-signature', wire: 'fixture-wire-not-broadcast' });
  mocks.send.mockRejectedValue(new Error('RPC lost response after accepting the transaction'));
  mocks.getAlarm.mockImplementation(async () => Date.now() + 60_000);
});
it('re-arms a stale past alarm after platform retries are exhausted', async () => {
  mocks.getAlarm.mockResolvedValue(Date.now() - 24 * 3600_000);
  const before = Date.now(); expect((await hub.fetch(new Request('https://fixture/api/config'))).status).toBe(200);
  expect(mocks.alarm).toHaveBeenCalledOnce();
  expect(mocks.alarm.mock.calls[0][0]).toBeGreaterThanOrEqual(before + 5_000);
});
it('does not postpone a healthy scheduled alarm when players browse', async () => {
  await hub.fetch(new Request('https://fixture/api/config')); expect(mocks.alarm).not.toHaveBeenCalled();
});
it('persists the next alarm before waiting for RPC, so page closure cannot stop refund processing', async () => {
  sentRefund(); let finish!: (value: object) => void;
  mocks.status.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const running = hub.alarm();
  await vi.waitFor(() => expect(mocks.status).toHaveBeenCalled());
  expect(mocks.alarm).toHaveBeenCalled();
  expect(mocks.alarm.mock.invocationCallOrder[0]).toBeLessThan(mocks.status.mock.invocationCallOrder[0]);
  expect(db.prepare('SELECT finished FROM maintenance_status').get()!.finished).toBeNull();
  finish({ ok: true, err: null }); await running;
  expect(db.prepare('SELECT status FROM lobby_payouts').get()!.status).toBe('paid');
  expect(db.prepare('SELECT finished FROM maintenance_status').get()!.finished).toEqual(expect.any(Number));
});
it('stops background wake-ups when there is no work and no recent player activity', async () => {
  await hub.alarm(); expect(mocks.deleteAlarm).toHaveBeenCalledOnce();
});
function sentRefund(lastValid: number | null = 100) {
  db.prepare("INSERT INTO lobby_payouts (lobby,uid,wallet,prize,burn,team,status,ts,kind,sig,last_valid) VALUES ('refund:fixture','fixture-player','public-wallet',1,0,0,'sent',1,'refund','public-signature',?)").run(lastValid);
}
it('never replaces an already processed refund even if the expiry height passed', async () => {
  sentRefund(); mocks.status.mockResolvedValue({ ok: null, err: null }); mocks.height.mockResolvedValue(500);
  await hub.alarm();
  expect(db.prepare('SELECT status FROM lobby_payouts').get()!.status).toBe('sent');
  expect(mocks.height).not.toHaveBeenCalled(); expect(mocks.build).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});
it('unlocks a replacement only when history is absent and finalized expiry has passed', async () => {
  sentRefund(); mocks.status.mockResolvedValue(null); mocks.height.mockResolvedValue(111);
  await hub.alarm();
  expect(db.prepare('SELECT status FROM lobby_payouts').get()!.status).toBe('pending');
  expect(mocks.build).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});
it('does not guess expiry for a legacy payout with no last-valid height', async () => {
  sentRefund(null); mocks.status.mockResolvedValue(null); mocks.height.mockResolvedValue(500);
  await hub.alarm();
  expect(db.prepare('SELECT status FROM lobby_payouts').get()!.status).toBe('sent');
  expect(mocks.height).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});
afterEach(() => db.close());
async function post(path: string, body: object = {}) {
  const token = await signSession({ uid: 'fixture-player', kind: 'guest', name: 'Fixture' }, env.SESSION_SECRET);
  return hub.fetch(new Request(`https://fixture${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ tx: 'fixture-partial-transaction', coinRevision: env.COIN_LAUNCH_REVISION, ...body }) }));
}
it.each(['/api/pay/sponsor', '/api/pay/withdraw'])('returns the persisted signature after an uncertain broadcast at %s', async path => {
  const r = await post(path);
  expect(r.status).toBe(202);
  expect(await r.json()).toEqual({ ok: true, pending: true, signature: 'public-fixture-signature' });
  expect(db.prepare('SELECT sig,uid FROM sponsored').all()).toEqual([{ sig: 'public-fixture-signature', uid: 'fixture-player' }]);
});
it.each(['/api/pay/sponsor', '/api/pay/withdraw'])('prepares a recoverable signed receipt without broadcasting at %s', async path => {
  const r = await post(path, { prepareOnly: true });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, signature: 'public-fixture-signature', wire: 'fixture-wire-not-broadcast' });
  expect(mocks.send).not.toHaveBeenCalled();
  expect(db.prepare('SELECT sig FROM sponsored').all()).toEqual([{ sig: 'public-fixture-signature' }]);
});
it.each(['/api/pay/sponsor', '/api/pay/withdraw'])('refuses invalid instructions before broadcasting at %s', async path => {
  mocks.cosign.mockRejectedValue(new Error('Invalid instructions'));
  expect((await post(path)).status).toBe(400);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(db.prepare('SELECT sig FROM sponsored').all()).toEqual([]);
});
