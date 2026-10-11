import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/game/hub';
import { signSession } from '../src/game/auth';
import { friendCode, normalizeFriendCode, friendEntryUsd, friendEntryUnits, splitFriendPot } from '../src/game/friendLobbies';
import { SETTLE_AFTER_MS } from '../src/game/lobbies';

const payments = vi.hoisted(() => ({ price: vi.fn(), read: vi.fn() }));
vi.mock('../src/game/solana', async original => ({ ...await original<object>(), coinPriceUsd: payments.price, readPayment: payments.read }));

// Real SQLite exercises the Hub routes, transactions and migrations, with devnet-only fixture tickets.
const env = { SESSION_SECRET: 'test-only-session', TICKET_CLUSTER: 'devnet', TICKET_MINT: 'devnet-test-mint', TICKET_TREASURY: 'test-treasury', TICKET_PRICE_USD: '20', TICKET_PRICE: '0', COIN_LAUNCH_READY: 'true', COIN_LAUNCH_REVISION: 'devnet-fixture' };
let db: DatabaseSync;
let hub: Hub;

function storage() {
  return {
    sql: { exec(q: string, ...args: unknown[]) {
      const statement = db.prepare(q);
      const values = args as (string | number | null)[];
      const rows = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
      return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('Expected one row'); return rows[0]; } };
    } },
    transactionSync<T>(fn: () => T): T {
      db.exec('SAVEPOINT test_tx');
      try { const value = fn(); db.exec('RELEASE test_tx'); return value; }
      catch (e) { db.exec('ROLLBACK TO test_tx'); db.exec('RELEASE test_tx'); throw e; }
    },
    setAlarm: async () => {}, getAlarm: async () => Date.now() + 60_000,
  };
}

beforeEach(() => { payments.price.mockReset().mockResolvedValue(0.01); payments.read.mockReset(); db = new DatabaseSync(':memory:'); hub = new Hub({ storage: storage() }, env); });
afterEach(() => { db.close(); vi.useRealTimers(); });

async function api(path: string, uid = 'host', body?: object, method?: string) {
  if (body !== undefined) body = { ...body, coinRevision: env.COIN_LAUNCH_REVISION };
  const token = await signSession({ uid, name: uid, kind: 'guest' }, env.SESSION_SECRET);
  return hub.fetch(new Request(`https://test${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
}
async function create() {
  const r = await api('/api/lobby/private/create', 'host', {});
  expect(r.status).toBe(200);
  return (await r.json()) as { lobby: { id: string; code: string; pot: number; status: string }; seats: unknown[] };
}
async function ticket(uid: string, mint = env.TICKET_MINT, amount = 100) {
  const sig = `${uid}-${crypto.randomUUID()}`;
  db.prepare('INSERT INTO tickets(sig, uid, wallet, amount, ts, mint) VALUES(?,?,?,?,?,?)').run(sig, uid, `public-wallet-${uid}`, amount, Date.now(), mint);
  return sig;
}
function left(uid: string) { return Number(db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE uid = ? AND used_ref IS NULL').get(uid)!.n); }
async function join(uid: string, code?: string) { return api('/api/lobby/join', uid, code ? { code } : {}); }
async function live(path: string, body: object) {
  return (await (await hub.fetch(new Request(`https://test/internal/live/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json()) as { ok: boolean; points: number };
}
function finish(id: string, time: number) { db.prepare("UPDATE runs SET status='done', finished=1, finish_time=?, input_log='[]' WHERE id=?").run(time, id); }

describe('live events use play points', () => {
  it('joins without a coin ticket and refunds play points on leaving', async () => {
    await api('/api/me');
    const initial = Number(db.prepare('SELECT points FROM users WHERE id=?').get('host')!.points);
    expect(await live('enter', { uid: 'host', ref: 'live:free', fee: 50 })).toMatchObject({ ok: true, points: initial - 50 });
    expect(await live('leave', { uid: 'host', ref: 'live:free' })).toMatchObject({ ok: true, points: initial });
    expect(left('host')).toBe(0);
  });
  it('does not consume a paid ticket when coin payments are paused', async () => {
    await api('/api/me'); await ticket('host');
    hub = new Hub({ storage: storage() }, { ...env, COIN_LAUNCH_READY: 'false' });
    expect(await live('enter', { uid: 'host', ref: 'live:paused', fee: 50, priorityFee: 200 })).toMatchObject({ ok: true });
    expect(left('host')).toBe(1);
    expect(await live('leave', { uid: 'host', ref: 'live:paused' })).toMatchObject({ ok: true });
    expect(left('host')).toBe(1);
  });
  it('does not charge twice or spend a ticket for an unaffordable points entry', async () => {
    await api('/api/me'); await ticket('host');
    db.prepare('UPDATE users SET points=100 WHERE id=?').run('host');
    expect(await live('enter', { uid: 'host', ref: 'live:insufficient', fee: 150 })).toMatchObject({ ok: false, points: 100 });
    expect(await live('enter', { uid: 'host', ref: 'live:once', fee: 50 })).toMatchObject({ ok: true, points: 50 });
    expect(await live('enter', { uid: 'host', ref: 'live:once', fee: 50 })).toMatchObject({ ok: false, points: 50 });
    expect(left('host')).toBe(1);
  });
});

describe('friend invites', () => {
  it('uses readable random codes and accepts a pasted link, lowercase or a spaced code', () => {
    const code = friendCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(normalizeFriendCode(code.toLowerCase())).toBe(code);
    expect(normalizeFriendCode(`${code.slice(0,4)}-${code.slice(4)}`)).toBe(code);
    expect(normalizeFriendCode(`https://example.test/#/race/friends/${code}`)).toBe(code);
    expect(normalizeFriendCode(null)).toBeNull();
    expect(normalizeFriendCode('<script>')).toBeNull();
  });
  it('requires sign-in and POST and can migrate existing databases repeatedly', async () => {
    expect((await hub.fetch(new Request('https://test/api/lobby/private/create', { method: 'POST' }))).status).toBe(401);
    expect((await api('/api/lobby/private/create')).status).toBe(405);
    hub = new Hub({ storage: storage() }, env);
    expect((await create()).lobby.code).toHaveLength(8);
  });
  it('create and preview consume no tickets, hide the seed and payment wallets, and retain hosted lobbies', async () => {
    await ticket('host');
    const v = await create();
    expect(left('host')).toBe(1);
    expect(v.seats).toHaveLength(0);
    const view = await api('/api/lobby/private/view', 'friend', { code: v.lobby.code });
    const text = await view.text();
    expect(view.status).toBe(200);
    expect(text).not.toContain('seed');
    expect(text).not.toContain('public-wallet');
    expect(left('host')).toBe(1);
    const mine = await (await api('/api/lobby/mine')).json() as { lobbies: { lobby: { id: string } }[] };
    expect(mine.lobbies[0].lobby.id).toBe(v.lobby.id);
  });
  it('keeps private lobbies out of public matchmaking and spends exactly one ticket per valid seat', async () => {
    const v = await create();
    await ticket('host'); await ticket('stranger');
    const pub = await (await join('stranger')).json() as { lobby: string; code: string | null };
    expect(pub.lobby).not.toBe(v.lobby.id);
    expect(pub.code).toBeNull();
    const own = await (await join('host', v.lobby.code)).json() as { lobby: string; code: string; ghosts: unknown[] };
    expect(own.lobby).toBe(v.lobby.id);
    expect(own.code).toBe(v.lobby.code);
    expect(own.ghosts).toEqual([]);
    expect(left('host')).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs WHERE lobby=?').get(v.lobby.id)!.n).toBe(1);
  });
  it('rejects missing, invalid, closed, wrong-mint and old-price invites without consuming tickets', async () => {
    const v = await create(); await ticket('friend');
    for (const code of ['BAD', 'ABCDEFGH']) { expect((await join('friend',code)).status).toBeGreaterThanOrEqual(400); expect(left('friend')).toBe(1); }
    db.prepare('UPDATE lobbies SET mint=? WHERE id=?').run('old-mint',v.lobby.id);
    expect((await join('friend',v.lobby.code)).status).toBe(409);
    db.prepare('UPDATE lobbies SET mint=?, price=30 WHERE id=?').run(env.TICKET_MINT,v.lobby.id);
    expect((await join('friend',v.lobby.code)).status).toBe(409);
    db.prepare("UPDATE lobbies SET price=20,status='settled' WHERE id=?").run(v.lobby.id);
    expect((await join('friend',v.lobby.code)).status).toBe(409);
    expect(left('friend')).toBe(1);
  });
  it('rejects old-coin tickets, active races and repeat entries without spending again', async () => {
    const v = await create(); await ticket('friend','old-mint');
    expect((await join('friend',v.lobby.code)).status).toBe(400);
    await ticket('friend');
    const run = await (await join('friend',v.lobby.code)).json() as { run: string };
    await ticket('friend');
    expect((await join('friend',v.lobby.code)).status).toBe(400);
    finish(run.run,60);
    expect((await join('friend',v.lobby.code)).status).toBe(409);
    expect(left('friend')).toBe(2); // old-coin ticket and the second current-coin ticket
  });
  it('caps seats at 5, preserves ghosts and queues the exact 80/15/5 payout once', async () => {
    const v=await create();
    for(let i=0;i<5;i++) {
      await ticket(`p${i}`,env.TICKET_MINT,100+i);
      const r=await join(`p${i}`,v.lobby.code); expect(r.status).toBe(200);
      const run=await r.json() as {run:string;ghosts:unknown[]}; expect(run.ghosts.length).toBe(i); finish(run.run,70+i);
    }
    await ticket('sixth'); expect((await join('sixth',v.lobby.code)).status).toBe(409); expect(left('sixth')).toBe(1);
    await api('/api/lobby/private/view','host',{code:v.lobby.code});
    const po=db.prepare('SELECT * FROM lobby_payouts WHERE lobby=?').get(v.lobby.id)!;
    expect([po.prize,po.burn,po.team,po.wallet,po.status]).toEqual([408,76.5,25.5,'public-wallet-p0','pending']);
    await api('/api/lobby/private/view','host',{code:v.lobby.code});
    expect(db.prepare('SELECT COUNT(*) AS n FROM payouts WHERE lobby=?').get(v.lobby.id)!.n).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lobby_payouts WHERE lobby=?').get(v.lobby.id)!.n).toBe(1);
  });
  it('returns tickets with 3 or fewer players after 30 minutes; settled rooms cannot be re-entered', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    const v=await create();
    for(let i=0;i<3;i++){await ticket(`p${i}`); const run=await (await join(`p${i}`,v.lobby.code)).json() as {run:string};finish(run.run,60+i);}
    vi.setSystemTime(Date.now()+SETTLE_AFTER_MS+1);
    const view=await (await api('/api/lobby/private/view','host',{code:v.lobby.code})).json() as typeof v;
    expect(view.lobby.status).toBe('refunded'); for(let i=0;i<3;i++)expect(left(`p${i}`)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lobby_payouts').get()!.n).toBe(0);
    await ticket('late');expect((await join('late',v.lobby.code)).status).toBe(409);expect(left('late')).toBe(1);
  });
  it('waits for active runs at the deadline then settles with 4 players', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    const v=await create();
    for(let i=0;i<3;i++){await ticket(`p${i}`);const r=await (await join(`p${i}`,v.lobby.code)).json() as {run:string};finish(r.run,70+i);}
    vi.setSystemTime(Date.now()+SETTLE_AFTER_MS-10_000);
    await ticket('p3');const r=await (await join('p3',v.lobby.code)).json() as {run:string};
    vi.setSystemTime(Date.now()+10_001);
    expect(((await (await api('/api/lobby/private/view','host',{code:v.lobby.code})).json()) as typeof v).lobby.status).toBe('open');
    finish(r.run,80);
    expect(((await (await api('/api/lobby/private/view','host',{code:v.lobby.code})).json()) as typeof v).lobby.status).toBe('settled');
    expect(db.prepare('SELECT prize,burn,team FROM lobby_payouts').get()).toMatchObject({prize:320,burn:60,team:20});
  });
  it('limits open lobbies without touching tickets', async () => {
    await ticket('host');await create();await create();await create();
    expect((await api('/api/lobby/private/create','host',{})).status).toBe(429);expect(left('host')).toBe(1);
  });
});
describe('custom friend entries (devnet payment fixtures)', () => {
  it('splits fractional-token entries exactly and conserves every raw unit', () => {
    const s = splitFriendPot('12345678', 5, 6);
    expect(s.rawUnits).toEqual({ prize:'49382712', burn:'9259258', team:'3086420' });
    expect(BigInt(s.rawUnits.prize)+BigInt(s.rawUnits.burn)+BigInt(s.rawUnits.team)).toBe(61728390n);
  });
  type View = { entryReady: boolean; refund: {amount:number;status:string}|null; lobby: {id:string;code:string;status:string;pot:number;entry:{usd:number;coins:number}} };
  async function custom(usd=12.5): Promise<View> {
    const response = await api('/api/lobby/private/create','host',{entryUsd:usd});
    expect(response.status).toBe(200);
    return await response.json() as View;
  }
  async function quote(uid:string, code:string) {
    const response=await api('/api/ticket/intent',uid,{code});
    expect(response.status).toBe(200);
    return await response.json() as {memo:string;price:number;usd:number;entryUnits:string};
  }
  async function claim(uid:string, q:{memo:string;price:number;entryUnits:string}, amount=q.price, sig=crypto.randomUUID()) {
    payments.read.mockResolvedValue({wallet:`payer-${uid}`,amount,units:String(Math.round(amount*1e6)),memos:[q.memo]});
    const response=await api('/api/ticket/claim',uid,{signature:sig});
    expect(response.status).toBe(200);
    return {sig,result:await response.json() as {entryReady:boolean;refunded:boolean}};
  }
  it('validates cents and safe token arithmetic without coercion', async () => {
    for (const value of [0,-1,1.001,NaN,Infinity,'10',null]) expect(friendEntryUsd(value)).toBeNull();
    expect(friendEntryUsd(0.29)).toBe(0.29);
    expect(friendEntryUnits(Infinity,6)).toBeNull();
    expect(friendEntryUnits(Number.MAX_SAFE_INTEGER,6)).toBeNull();
    for(const entryUsd of [0,-1,1.001,'20',null]) expect((await api('/api/lobby/private/create','host',{entryUsd})).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lobbies').get()!.n).toBe(0);
  });
  it('locks the chosen dollar entry and the exact coin quote across players, price changes and restart', async () => {
    const v=await custom(12.5);
    expect(v.lobby.entry).toEqual({usd:12.5,coins:1250});
    payments.price.mockResolvedValue(0.04);
    hub=new Hub({storage:storage()},env);
    for(let i=0;i<5;i++) expect(await quote('p'+i,v.lobby.code)).toMatchObject({usd:12.5,price:1250,entryUnits:'1250000000'});
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n).toBe(0);
  });
  it('refuses a custom dollar quote without a market price on mainnet, even with a fixed ticket fallback', async () => {
    payments.price.mockResolvedValue(null);
    hub = new Hub({storage:storage()}, {...env,TICKET_CLUSTER:'mainnet-beta',TICKET_PRICE:'100'});
    expect((await api('/api/lobby/private/create','host',{entryUsd:10})).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lobbies').get()!.n).toBe(0);
  });
  it('requires a payment for this particular lobby; ordinary tickets cannot replace it and no host gets a free entry', async () => {
    const v=await custom();
    await ticket('host');
    expect((await join('host',v.lobby.code)).status).toBe(400);
    expect(left('host')).toBe(1);
    const paid=await claim('host',await quote('host',v.lobby.code));
    expect(paid.result.entryReady).toBe(true);
    const publicRun = await join('host');
    expect(publicRun.status).toBe(200); // consumes only the ordinary ticket
    finish((await publicRun.json() as {run:string}).run,70);
    expect(db.prepare('SELECT used_ref FROM tickets WHERE sig=?').get(paid.sig)!.used_ref).toBeNull();
    const another=await custom(12.5);
    expect((await join('host',another.lobby.code)).status).toBe(400); // cannot use a different lobby's payment
    expect(db.prepare('SELECT used_ref FROM tickets WHERE sig=?').get(paid.sig)!.used_ref).toBeNull();
  });
  it('enforces identical entries for five players, ignores forged client amounts and pays the exact split once', async () => {
    const v=await custom(7.25);
    for(let i=0;i<5;i++) {
      await claim('p'+i,await quote('p'+i,v.lobby.code));
      const r=await api('/api/lobby/join','p'+i,{code:v.lobby.code,amount:1,entryUsd:1});
      expect(r.status).toBe(200);
      finish((await r.json() as {run:string}).run,65+i);
    }
    expect((await api('/api/ticket/intent','sixth',{code:v.lobby.code})).status).toBe(409);
    await api('/api/lobby/private/view','host',{code:v.lobby.code});
    const row=db.prepare('SELECT * FROM lobby_payouts WHERE lobby=?').get(v.lobby.id)!;
    expect([row.prize,row.burn,row.team,row.wallet]).toEqual([2900,543.75,181.25,'payer-p0']);
    expect(db.prepare('SELECT COUNT(DISTINCT amount) AS n FROM tickets WHERE lobby_id=?').get(v.lobby.id)!.n).toBe(1);
    expect(db.prepare('SELECT SUM(amount) AS n FROM tickets WHERE lobby_id=?').get(v.lobby.id)!.n).toBe(3625);
    await api('/api/lobby/private/view','host',{code:v.lobby.code});
    expect(db.prepare('SELECT COUNT(*) AS n FROM lobby_payouts').get()!.n).toBe(1);
  });
  it('refuses coin shortages and excess down to one raw unit and queues a full refund to the original payer', async () => {
    const v=await custom(10);
    for(const amount of [999.999999,1000.000001]) {
      const q=await quote('friend',v.lobby.code), paid=await claim('friend',q,amount);
      expect(paid.result).toMatchObject({entryReady:false,refunded:true});
      const row=db.prepare('SELECT * FROM lobby_payouts WHERE lobby=?').get('refund:'+paid.sig)!;
      expect([row.prize,row.burn,row.team,row.wallet,row.status]).toEqual([amount,0,0,'payer-friend','pending']);
      await api('/api/ticket/claim','friend',{signature:paid.sig});
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM lobby_payouts').get()!.n).toBe(2);
    expect((await join('friend',v.lobby.code)).status).toBe(400);
  });
  it('deduplicates concurrent confirmations, refuses payment theft, and returns an accidental second payment', async () => {
    const v=await custom(), q=await quote('friend',v.lobby.code), sig=crypto.randomUUID();
    payments.read.mockResolvedValue({wallet:'payer-friend',amount:q.price,units:q.entryUnits,memos:[q.memo]});
    const confirmed=await Promise.all([api('/api/ticket/claim','friend',{signature:sig}),api('/api/ticket/claim','friend',{signature:sig})]);
    expect(confirmed.map(r=>r.status)).toEqual([200,200]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE lobby_id=?').get(v.lobby.id)!.n).toBe(1);
    expect((await api('/api/ticket/claim','thief',{signature:sig})).status).toBe(400);
    const extra=await claim('friend',q);
    expect(extra.result.refunded).toBe(true);
    expect(db.prepare('SELECT used_ref FROM tickets WHERE sig=?').get(sig)!.used_ref).toBeNull();
    expect((await api('/api/ticket/intent','friend',{code:v.lobby.code})).status).toBe(409);
  });
  it('returns a sixth payment quoted before the other players filled all five paid places', async () => {
    const v=await custom(), sixth=await quote('sixth',v.lobby.code);
    for(let i=0;i<5;i++)await claim('p'+i,await quote('p'+i,v.lobby.code));
    const view=await (await api('/api/lobby/private/view','host',{code:v.lobby.code})).json() as {lobby:{seats:number};seats:{ready:boolean}[]};
    expect(view.lobby.seats).toBe(5);
    expect(view.seats.every(s=>s.ready)).toBe(true);
    const late=await claim('sixth',sixth);
    expect(late.result.refunded).toBe(true);
    const run=await join('p4',v.lobby.code); expect(run.status).toBe(200); // fifth paid player still gets their run
  });
  it('refunds late confirmation instead of creating a spendable ticket or a race in a closed lobby', async () => {
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    const v=await custom(), q=await quote('friend',v.lobby.code);
    vi.setSystemTime(Date.now()+SETTLE_AFTER_MS+1);
    expect((await api('/api/coin/preflight','friend',{mint:env.TICKET_MINT,purpose:'ticket',memo:q.memo})).status).toBe(409);
    const p=await claim('friend',q);
    expect(p.result).toMatchObject({entryReady:false,refunded:true});
    expect((await join('friend',v.lobby.code)).status).toBe(409);
  });
  it('refunds completed entries and unused payments at timeout without charging burn or team fees', async () => {
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    const v=await custom(5);
    for(let i=0;i<4;i++) {
      await claim('p'+i,await quote('p'+i,v.lobby.code));
      if(i<3)finish((await (await join('p'+i,v.lobby.code)).json() as {run:string}).run,65+i);
    }
    vi.setSystemTime(Date.now()+SETTLE_AFTER_MS+1);
    const view=await (await api('/api/lobby/private/view','p0',{code:v.lobby.code})).json() as View;
    expect(view.lobby.status).toBe('refunded');
    expect(view.refund).toEqual({amount:500,status:'pending'});
    const rows=db.prepare('SELECT * FROM lobby_payouts').all();
    expect(rows).toHaveLength(4);
    expect(rows.every(r=>r.prize===500&&r.burn===0&&r.team===0&&r.kind==='refund')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE used_ref IS NULL').get()!.n).toBe(0);
    await api('/api/lobby/private/view','p0',{code:v.lobby.code});
    expect(db.prepare('SELECT COUNT(*) AS n FROM lobby_payouts').get()!.n).toBe(4);
  });
  it('settles four completed runs at timeout and separately returns the fifth unused payment', async () => {
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    const v=await custom(5);
    for(let i=0;i<5;i++) {
      await claim('p'+i,await quote('p'+i,v.lobby.code));
      if(i<4)finish((await (await join('p'+i,v.lobby.code)).json() as {run:string}).run,65+i);
    }
    vi.setSystemTime(Date.now()+SETTLE_AFTER_MS+1);
    await api('/api/lobby/private/view','host',{code:v.lobby.code});
    expect(db.prepare('SELECT prize,burn,team FROM lobby_payouts WHERE kind=\'prize\'').get()).toMatchObject({prize:1600,burn:300,team:100});
    expect(db.prepare('SELECT prize,burn,team,uid FROM lobby_payouts WHERE kind=\'refund\'').get()).toMatchObject({prize:500,burn:0,team:0,uid:'p4'});
  });
});
