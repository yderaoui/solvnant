import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Hub } from '../src/game/hub';
import { signSession } from '../src/game/auth';
import { readConfig } from '../src/game/config';

const mocks = vi.hoisted(() => ({ verify: vi.fn(), price: vi.fn(), readiness: vi.fn() }));
vi.mock('../src/game/paidReadiness', () => ({ paidReadinessProblem: mocks.readiness }));
vi.mock('../src/game/pumpTrade', () => ({ verifyPumpCoin: mocks.verify }));
vi.mock('../src/game/solana', async importOriginal => ({ ...await importOriginal<object>(), coinPriceUsd: mocks.price }));
const mint = 'So11111111111111111111111111111111111111112'; // devnet fixtures, never sent
const nextMint = '11111111111111111111111111111111';
const env = { SESSION_SECRET: 'fixture-session', COIN_ADMIN_KEY: 'fixture-operations-only', TICKET_CLUSTER: 'devnet', TICKET_MINT: mint, TICKET_TREASURY: nextMint, TICKET_PRICE_USD: '20', TICKET_PRICE: '0', COIN_LAUNCH_REVISION: 'fixture-v1' };
let db: DatabaseSync, hub: Hub, now: number;
function state() {
  return { storage: {
    sql: { exec(sql: string, ...args: unknown[]) {
      const s = db.prepare(sql), values = args as (string | number | null)[];
      const rows = s.columns().length ? s.all(...values) : (s.run(...values), []);
      return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('Expected one row'); return rows[0]; } };
    } },
    transactionSync<T>(fn: () => T) { db.exec('SAVEPOINT fixture'); try { const result = fn(); db.exec('RELEASE fixture'); return result; } catch(e) { db.exec('ROLLBACK TO fixture'); db.exec('RELEASE fixture'); throw e; } },
    getAlarm: async () => Date.now() + 60_000, setAlarm: async () => {},
  } };
}
beforeEach(() => {
  db = new DatabaseSync(':memory:'); now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mocks.verify.mockReset().mockResolvedValue({ decimals: 6, route: 'pump.fun' });
  mocks.price.mockReset().mockResolvedValue(0.002);
  mocks.readiness.mockReset().mockResolvedValue(null);
  hub = new Hub(state(), env);
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });
async function config() { return (await hub.fetch(new Request('https://fixture/api/config'))).json(); }
async function admin(action: string, extra: object = {}, key = env.COIN_ADMIN_KEY) {
  const cfg = await config();
  return hub.fetch(new Request('https://fixture/api/admin/coin', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, revision: cfg.coinLaunch.revision, ...extra }) }));
}
async function api(path: string, body: object) {
  const token = await signSession({ uid: 'fixture-player', kind: 'guest', name: 'Fixture' }, env.SESSION_SECRET);
  return hub.fetch(new Request(`https://fixture${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}
async function prepare() { await admin('pause'); now += 120_001; return admin('prepare', { mint: nextMint, symbol: '$PUMP' }); }

it('defaults to a launch lock and creates no payment intents or lobby seats', async () => {
  expect(readConfig(env).coinLaunch.status).toBe('paused');
  for (const p of ['/api/ticket/intent','/api/skin/intent','/api/pay/sponsor','/api/lobby/join','/api/lobby/private/create','/api/coin/preflight']) expect((await api(p, { coinRevision: 'fixture-v1' })).status).toBe(409);
  expect(db.prepare('SELECT COUNT(*) AS n FROM pay_memos').get()!.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n).toBe(0);
});
it('rejects legacy browsers without the launch revision even when live', async () => {
  hub = new Hub(state(), { ...env, COIN_LAUNCH_READY: 'true' });
  expect((await api('/api/ticket/intent', {})).status).toBe(409);
  const response = await api('/api/ticket/intent', { coinRevision: 'fixture-v1' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ mint, coinRevision: 'fixture-v1', price: 10_000 });
});
it('only the operations secret can pause or switch; GET cannot mutate', async () => {
  expect((await admin('pause', {}, 'wrong-key')).status).toBe(401);
  expect((await hub.fetch(new Request('https://fixture/api/admin/coin', { headers: { authorization: `Bearer ${env.COIN_ADMIN_KEY}` } }))).status).toBe(405);
  expect((await config()).coinLaunch.revision).toBe('fixture-v1');
});
it('requires a pause and drain period, prepares atomically, and persists across restarts', async () => {
  expect((await admin('prepare', { mint: nextMint, symbol: '$PUMP' })).status).toBe(409);
  await admin('pause');
  expect((await admin('prepare', { mint: nextMint, symbol: '$PUMP' })).status).toBe(409);
  now += 120_001;
  expect((await admin('prepare', { mint: nextMint, symbol: '$PUMP' })).status).toBe(200);
  const cfg = await config();
  expect(cfg.coinLaunch.status).toBe('paused'); expect(cfg.tickets).toMatchObject({ mint: nextMint, symbol: '$PUMP', priceUsd: 20, treasury: nextMint });
  expect((await api('/api/coin/preflight', { mint: nextMint, coinRevision: cfg.coinLaunch.revision })).status).toBe(409);
  hub = new Hub(state(), env);
  expect((await config()).tickets.mint).toBe(nextMint);
  expect(() => new Hub(state(), { ...env, TICKET_CLUSTER: 'mainnet-beta' })).toThrow('network');
});
it('leaves the previous coin paused when verification fails', async () => {
  mocks.verify.mockRejectedValue(new Error('Mint not found'));
  expect((await prepare()).status).toBe(500);
  expect((await config()).tickets.mint).toBe(mint);
  expect((await config()).coinLaunch.status).toBe('paused');
});
it('will not switch away from an outstanding race pot', async () => {
  db.prepare("INSERT INTO lobbies (id,seed,price,status,created,mint) VALUES ('old-pot','fixture',20,'open',?,?)").run(now,mint);
  expect((await prepare()).status).toBe(409);
  expect(mocks.verify).not.toHaveBeenCalled();
});
it('requires working USD pricing to enable and rejects stale/wrong-mint quotes after enabling', async () => {
  await prepare(); mocks.price.mockResolvedValue(null);
  expect((await admin('enable')).status).toBe(409);
  expect((await config()).coinLaunch.status).toBe('paused');
  mocks.price.mockResolvedValue(0.002);
  expect((await admin('enable')).status).toBe(200);
  const revision = (await config()).coinLaunch.revision;
  expect((await api('/api/coin/preflight', { mint: nextMint, coinRevision: 'fixture-v1' })).status).toBe(409);
  expect((await api('/api/coin/preflight', { mint, coinRevision: revision })).status).toBe(409);
  expect((await api('/api/coin/preflight', { mint: nextMint, coinRevision: revision, purpose: 'coin' })).status).toBe(200);
  await admin('pause');
  expect((await api('/api/coin/preflight', { mint: nextMint, coinRevision: revision })).status).toBe(409);
});

it('opens test coin buying while enforcing the paid-race lock on the server, across restarts', async () => {
  await admin('pause'); now += 120_001;
  expect((await admin('prepare', { mint: nextMint, symbol: '$RACE', mode: 'test' })).status).toBe(200);
  expect((await admin('enable')).status).toBe(200);
  hub = new Hub(state(), env);
  const cfg = await config();
  expect(cfg.coinLaunch).toMatchObject({ status: 'live', buyEnabled: true, mode: 'test', paidEnabled: false });
  expect(cfg.sponsor).toBeNull();
  expect(mocks.readiness).not.toHaveBeenCalled();
  const body = { mint: nextMint, coinRevision: cfg.coinLaunch.revision };
  expect((await api('/api/coin/preflight', { ...body, purpose: 'coin' })).status).toBe(200);
  expect((await api('/api/coin/preflight', { ...body, purpose: 'ticket' })).status).toBe(409);
  for (const path of ['/api/ticket/intent', '/api/skin/intent', '/api/pay/sponsor', '/api/lobby/join', '/api/lobby/private/create']) {
    expect((await api(path, body)).status).toBe(409);
  }
  expect(db.prepare('SELECT COUNT(*) AS n FROM pay_memos').get()!.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM lobbies').get()!.n).toBe(0);
});

it('an official prepare clears the temporary test mode and restores paid-race readiness', async () => {
  await admin('pause'); now += 120_001;
  await admin('prepare', { mint: nextMint, symbol: '$RACE', mode: 'test', paidEnabled: false });
  expect((await admin('prepare', { mint: nextMint, symbol: '$PUMP' })).status).toBe(200);
  expect((await config()).coinLaunch).toMatchObject({ mode: 'official', paidEnabled: true, status: 'paused' });
});

it('keeps paid tests paused until payout funding checks succeed', async () => {
  await admin('pause'); now += 120_001;
  await admin('prepare', { mint: nextMint, symbol: '$RACE', mode: 'test', paidEnabled: true });
  mocks.readiness.mockResolvedValue('The treasury needs at least 0.02 SOL.');
  const paused = (await config()).coinLaunch;
  expect((await admin('enable')).status).toBe(409);
  expect((await config()).coinLaunch).toEqual(paused);
  mocks.readiness.mockResolvedValue(null);
  expect((await admin('enable')).status).toBe(200);
  expect((await config()).coinLaunch).toMatchObject({ status: 'live', mode: 'test', paidEnabled: true });
});
it('reports readiness and outstanding money without changing the coin or opening payments', async () => {
  mocks.readiness.mockResolvedValue('The treasury needs at least 0.02 SOL.');
  const before = await config();
  const r = await admin('check');
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ paidReady: false, paidProblem: 'The treasury needs at least 0.02 SOL.', outstanding: { openLobbies: 0, payouts: 0, unusedTickets: 0 } });
  expect(await config()).toEqual(before);
});
it('inspects a locked friend entry without changing expired lobbies, balances or launch settings', async () => {
  db.prepare("INSERT INTO lobbies (id,seed,price,status,created,mint,invite_code,entry_usd,entry_units) VALUES ('inspection-fixture','fixture',20,'open',?,?,'RK5J6F78',0.01,'1234567')").run(now - 31 * 60_000, mint);
  db.prepare('INSERT INTO tickets (sig,uid,wallet,amount,ts,mint,lobby_id,amount_units) VALUES (?,?,?,?,?,?,?,?)').run('fixture-signature','fixture-player','public-fixture-wallet',1.234567,now,mint,'inspection-fixture','1234567');
  const before = await config();
  const r = await admin('check', { code: 'rk5j6f78' });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ friendLobby: {
    mint, entryUnits: '1234567', lobby: { code: 'RK5J6F78', status: 'open', entry: { usd: 0.01, coins: 1.234567 } },
    payments: [{ sig: 'fixture-signature', amount_units: '1234567' }], refunds: [],
  } });
  expect(await config()).toEqual(before);
  expect(db.prepare('SELECT status FROM lobbies').get()!.status).toBe('open');
  expect(db.prepare('SELECT COUNT(*) AS n FROM lobby_payouts').get()!.n).toBe(0);
  expect(db.prepare('SELECT used_ref FROM tickets').get()!.used_ref).toBeNull();
});
it('restricts lobby inspection to operations authentication and rejects invalid/unknown codes', async () => {
  expect((await admin('check', { code: 'RK5J6F78' }, 'wrong-key')).status).toBe(401);
  expect((await admin('check', { code: "' OR 1=1 --" })).status).toBe(400);
  expect((await admin('check', { code: 'RK5J6F78' })).status).toBe(404);
  expect(mocks.readiness).not.toHaveBeenCalled();
});

it('rejects malformed operational test settings before on-chain verification', async () => {
  await admin('pause'); now += 120_001;
  expect((await admin('prepare', { mint: nextMint, symbol: '$RACE', mode: 'fake' })).status).toBe(400);
  expect((await admin('prepare', { mint: nextMint, symbol: '$RACE', paidEnabled: 'false' })).status).toBe(400);
  expect(mocks.verify).not.toHaveBeenCalled();
});
it('does not overwrite a newer pause while on-chain verification is in flight', async () => {
  await admin('pause'); now += 120_001;
  let finish!: (value: object) => void;
  mocks.verify.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = admin('prepare', { mint: nextMint, symbol: '$PUMP' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  await admin('pause');
  finish({ decimals: 6 });
  expect((await pending).status).toBe(409);
  expect((await config()).tickets.mint).toBe(mint);
});

it('expires ticket quotes and invalidates them across a pause even for the same mint', async () => {
  hub = new Hub(state(), { ...env, COIN_LAUNCH_READY: 'true', COIN_BUY_ENABLED: 'true' });
  const q = await (await api('/api/ticket/intent', { coinRevision: 'fixture-v1' })).json();
  const body = { mint, coinRevision: 'fixture-v1', purpose: 'ticket', memo: q.memo };
  expect((await api('/api/coin/preflight', body)).status).toBe(200);
  now += 120_001;
  expect((await api('/api/coin/preflight', body)).status).toBe(409);
  const fresh = await (await api('/api/ticket/intent', { coinRevision: 'fixture-v1' })).json();
  await admin('pause'); now += 120_001; await admin('enable');
  const revision = (await config()).coinLaunch.revision;
  expect((await api('/api/coin/preflight', { ...body, memo: fresh.memo, coinRevision: revision })).status).toBe(409);
});
