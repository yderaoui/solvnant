// The Hub: one Durable Object (SQLite storage, free plan) that owns accounts, PLAY-MONEY points,
// the points ledger, betting markets (live races + AI League) and live-race prize pots.
// Public routes live under /api/* (called by browsers with a session token); /internal/* routes
// are only reachable from the live race room (the Worker never forwards /internal from outside).
import { publicConfig, publicTickets, readConfig, type GameConfig } from './config';
import { bearer, randomToken, signSession, verifySession, type Session } from './auth';
import { isSolanaAddress, tokenHolding, verifyTicketPayment, verifyWalletSignature, walletMessage } from './solana';
import { poolOdds, prizeSplit, settlePool } from './economy';
import { cleanName } from './protocol';
import { verifyPrivyToken } from './privy';
import { DEFAULT_SKIN, SKINS, isSkin, skinById } from './skins';

interface SqlCursor {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}
interface DOState {
  storage: {
    sql: { exec(q: string, ...args: unknown[]): SqlCursor };
    transactionSync<T>(fn: () => T): T;
    setAlarm(ms: number): Promise<void>;
    getAlarm(): Promise<number | null>;
  };
}

export interface UserRow {
  id: string;
  kind: 'x' | 'guest' | 'privy';
  handle: string | null;
  name: string;
  avatar: string | null;
  points: number;
  wallet: string | null;
  hold_usd: number | null;
  hold_at: number | null;
  daily_at: number;
  created: number;
}

interface LiveEntry {
  fee: number; // entry fee (in the pot)
  prio: number; // priority pass (refundable until lights out, never in the pot)
}

export interface MarketPick {
  id: string;
  name: string;
  color: string;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);
const LEAGUE_COUNTDOWN_MS = 45_000; // must match src/sim/schedule.ts COUNTDOWN_MS
const LIVE_POT_TIMEOUT_MS = 15 * 60_000;
const HOLD_CACHE_MS = 10 * 60_000;
const AGENT_MAX_BYTES = 20_000; // = SANDBOX_LIMITS.codeBytes
const AGENT_PER_DAY = 5;

export class Hub {
  private cfg: GameConfig;
  private sql: DOState['storage']['sql'];
  private lastActivity = 0;

  constructor(
    private state: DOState,
    env: Record<string, string | undefined>,
  ) {
    this.cfg = readConfig(env);
    this.sql = state.storage.sql;
    this.migrate();
  }

  private migrate() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, handle TEXT, name TEXT NOT NULL, avatar TEXT,
      points INTEGER NOT NULL DEFAULT 0, wallet TEXT, hold_usd REAL, hold_at INTEGER,
      daily_at INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, delta INTEGER NOT NULL,
      reason TEXT NOT NULL, ref TEXT, ts INTEGER NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS ledger_uid ON ledger(uid, ts)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      closes_at INTEGER, settle_after INTEGER, picks TEXT NOT NULL, drivers TEXT NOT NULL DEFAULT '[]',
      winner TEXT, created INTEGER NOT NULL, settled INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT NOT NULL, uid TEXT NOT NULL, pick TEXT NOT NULL,
      amount INTEGER NOT NULL, payout INTEGER, ts INTEGER NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS bets_market ON bets(market)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS live_pots (
      ref TEXT PRIMARY KEY, status TEXT NOT NULL, fee INTEGER NOT NULL, entries TEXT NOT NULL,
      pot INTEGER NOT NULL, created INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS nonces (uid TEXT PRIMARY KEY, nonce TEXT NOT NULL, ts INTEGER NOT NULL)`);
    // Race tickets paid in the game coin: one row per on-chain payment (the signature can't be reused).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tickets (
      sig TEXT PRIMARY KEY, uid TEXT NOT NULL, wallet TEXT NOT NULL, amount REAL NOT NULL,
      ts INTEGER NOT NULL, used_ref TEXT)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS tickets_uid ON tickets(uid, used_ref)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ticket_memos (uid TEXT PRIMARY KEY, memo TEXT NOT NULL, ts INTEGER NOT NULL)`);
    // Racer skins bought with the game coin (one row per skin per player; the payment can't be reused).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS skins (
      uid TEXT NOT NULL, skin TEXT NOT NULL, sig TEXT NOT NULL UNIQUE, wallet TEXT NOT NULL, amount REAL NOT NULL,
      ts INTEGER NOT NULL, PRIMARY KEY (uid, skin))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS skin_memos (uid TEXT PRIMARY KEY, skin TEXT NOT NULL, memo TEXT NOT NULL, ts INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS skin_choice (uid TEXT PRIMARY KEY, skin TEXT NOT NULL)`);
  }

  // ================================================================== routing
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    this.lastActivity = Date.now();
    void this.ensureAlarm();
    try {
      if (p.startsWith('/internal/')) return await this.internal(p, req);
      if (p === '/api/config') return json(publicConfig(this.cfg));
      if (p === '/api/guest' && req.method === 'POST') return await this.guest(req);
      if (p === '/api/privy' && req.method === 'POST') return await this.privyLogin(req);
      if (p === '/api/leaderboard') return json(this.leaderboard());
      if (p === '/api/market' && req.method === 'GET') return json(await this.marketView(url.searchParams.get('id') ?? '', await this.session(req)));
      if (p === '/api/markets' && req.method === 'GET') return json(this.openMarkets(url.searchParams.get('kind')));
      const s = await this.session(req);
      if (!s) return fail('Please sign in.', 401);
      const u = this.ensureUser(s);
      switch (p) {
        case '/api/me':
          return json(await this.me(u));
        case '/api/daily':
          return json(this.daily(u));
        case '/api/ledger':
          return json(this.sql.exec('SELECT delta, reason, ref, ts FROM ledger WHERE uid = ? ORDER BY id DESC LIMIT 50', u.id).toArray());
        case '/api/wallet/nonce': {
          const nonce = randomToken(12);
          this.sql.exec('INSERT OR REPLACE INTO nonces (uid, nonce, ts) VALUES (?, ?, ?)', u.id, nonce, Date.now());
          return json({ message: walletMessage(u.id, nonce) });
        }
        case '/api/wallet/verify':
          return await this.walletVerify(u, (await req.json()) as { address?: string; signature?: string });
        case '/api/wallet/refresh':
          return json(await this.me(u, true));
        case '/api/wallet/unlink':
          this.sql.exec('UPDATE users SET wallet = NULL, hold_usd = NULL, hold_at = NULL WHERE id = ?', u.id);
          return json(await this.me(this.user(u.id)!));
        case '/api/bet':
          return await this.bet(u, (await req.json()) as { market?: string; pick?: string; amount?: number });
        case '/api/ticket/intent':
          return this.ticketIntent(u);
        case '/api/ticket/claim':
          return await this.ticketClaim(u, (await req.json()) as { signature?: string });
        case '/api/skin/intent':
          return this.skinIntent(u, (await req.json()) as { skin?: string });
        case '/api/skin/claim':
          return await this.skinClaim(u, (await req.json()) as { signature?: string });
        case '/api/skin/select':
          return this.skinSelect(u, (await req.json()) as { skin?: string });
        case '/api/agents':
          return req.method === 'POST' ? await this.submitAgent(u, (await req.json()) as { name?: string; code?: string }) : json(await this.myAgents(u));
      }
      return fail('Not found', 404);
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'Server error', 500);
    }
  }

  private async session(req: Request): Promise<Session | null> {
    return verifySession(bearer(req), this.cfg.sessionSecret);
  }

  // ================================================================== accounts
  private user(id: string): UserRow | null {
    const rows = this.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray();
    return (rows[0] as unknown as UserRow) ?? null;
  }

  /** Make sure a signed-in person has a row (and their signup points). */
  private ensureUser(s: Session): UserRow {
    const u = this.user(s.uid);
    if (u) return u;
    this.state.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO users (id, kind, name, avatar, points, created) VALUES (?, ?, ?, ?, 0, ?)', s.uid, s.kind, s.name, s.avatar ?? null, Date.now());
      this.credit(s.uid, this.cfg.points.signup, 'signup bonus', null);
    });
    return this.user(s.uid)!;
  }

  /** Called by the Worker after an X login: create/refresh the account. */
  upsertX(id: string, handle: string, name: string, avatar: string | null): UserRow {
    const uid = `x:${id}`;
    const u = this.user(uid);
    if (u) this.sql.exec('UPDATE users SET handle = ?, name = ?, avatar = ? WHERE id = ?', handle, name, avatar, uid);
    else
      this.state.storage.transactionSync(() => {
        this.sql.exec('INSERT INTO users (id, kind, handle, name, avatar, points, created) VALUES (?, ?, ?, ?, ?, 0, ?)', uid, 'x', handle, name, avatar, Date.now());
        this.credit(uid, this.cfg.points.signup, 'signup bonus', null);
      });
    return this.user(uid)!;
  }

  /**
   * Privy sign-in: the browser sends its Privy access token (checked against Privy's public keys) and
   * what Privy shows about the person (X handle / email / picture), and gets a game session back.
   * The account id comes from the verified token; the display info is cosmetic.
   */
  private async privyLogin(req: Request): Promise<Response> {
    const appId = this.cfg.privyAppId;
    if (!appId) return fail('Privy sign-in is not set up on this server.', 403);
    const b = (await req.json().catch(() => ({}))) as { token?: string; handle?: string; name?: string; avatar?: string };
    const did = await verifyPrivyToken(String(b.token ?? ''), appId);
    if (!did) return fail('Sign-in could not be verified. Please try again.', 401);
    const uid = `privy:${did.replace(/^did:privy:/, '')}`;
    const handle = b.handle ? cleanName(b.handle) || null : null;
    const name = cleanName(b.name) || handle || 'Racer';
    const avatar = b.avatar && /^https:\/\//.test(b.avatar) ? String(b.avatar).slice(0, 400) : null;
    if (this.user(uid)) this.sql.exec('UPDATE users SET handle = ?, name = ?, avatar = ? WHERE id = ?', handle, name, avatar, uid);
    else
      this.state.storage.transactionSync(() => {
        this.sql.exec('INSERT INTO users (id, kind, handle, name, avatar, points, created) VALUES (?, ?, ?, ?, ?, 0, ?)', uid, 'privy', handle, name, avatar, Date.now());
        this.credit(uid, this.cfg.points.signup, 'signup bonus', null);
      });
    return json({ token: await signSession({ uid, name: handle ?? name, kind: 'privy', avatar: avatar ?? undefined }, this.cfg.sessionSecret) });
  }

  private async guest(req: Request): Promise<Response> {
    if (!this.cfg.allowGuests) return fail('Guest play is off. Sign in with X.', 403);
    const body = (await req.json().catch(() => ({}))) as { name?: string };
    const name = cleanName(body.name);
    if (!name) return fail('Pick a nickname (letters and numbers, up to 16).');
    const s: Session = { uid: `g:${randomToken(9)}`, name, kind: 'guest', exp: 0 };
    this.ensureUser(s);
    return json({ token: await signSession({ uid: s.uid, name, kind: 'guest' }, this.cfg.sessionSecret) });
  }

  private credit(uid: string, delta: number, reason: string, ref: string | null) {
    if (!delta) return;
    this.sql.exec('UPDATE users SET points = points + ? WHERE id = ?', delta, uid);
    this.sql.exec('INSERT INTO ledger (uid, delta, reason, ref, ts) VALUES (?, ?, ?, ?, ?)', uid, delta, reason, ref, Date.now());
  }

  /** Take points if the balance allows. Returns false (and changes nothing) otherwise. */
  private charge(uid: string, amount: number, reason: string, ref: string | null): boolean {
    const u = this.user(uid);
    if (!u || u.points < amount) return false;
    this.credit(uid, -amount, reason, ref);
    return true;
  }

  private daily(u: UserRow) {
    const now = Date.now();
    const next = u.daily_at + 20 * 3600_000;
    if (now < next) return { ok: false, next, points: u.points };
    this.state.storage.transactionSync(() => {
      this.sql.exec('UPDATE users SET daily_at = ? WHERE id = ?', now, u.id);
      this.credit(u.id, this.cfg.points.daily, 'daily bonus', null);
    });
    return { ok: true, next: now + 20 * 3600_000, points: this.user(u.id)!.points };
  }

  /** Who may drive in live races. Rule: signed in with X, OR (if a token gate is set) holding enough of the token. */
  private async eligibility(u: UserRow, refresh = false): Promise<{ ok: boolean; reason: string | null; holdUsd: number | null }> {
    const g = this.cfg.gate;
    let holdUsd = u.hold_usd;
    if (g && u.wallet && (refresh || !u.hold_at || Date.now() - u.hold_at > HOLD_CACHE_MS)) {
      try {
        const h = await tokenHolding(u.wallet, g);
        holdUsd = h.usd ?? 0;
        this.sql.exec('UPDATE users SET hold_usd = ?, hold_at = ? WHERE id = ?', holdUsd, Date.now(), u.id);
      } catch {
        /* keep the cached value if the RPC is down */
      }
    }
    const holds = !!g && (holdUsd ?? 0) >= g.minUsd;
    if (u.kind === 'x' || u.kind === 'privy' || holds) return { ok: true, reason: null, holdUsd };
    if (!g) return this.cfg.allowGuests ? { ok: true, reason: null, holdUsd } : { ok: false, reason: 'Sign in with X to race.', holdUsd };
    return { ok: false, reason: `Sign in with X, or link a wallet holding at least $${g.minUsd} of the token, to race.`, holdUsd };
  }

  private async me(u: UserRow, refresh = false) {
    const el = await this.eligibility(u, refresh);
    u = this.user(u.id)!;
    return {
      id: u.id,
      kind: u.kind,
      handle: u.handle,
      name: u.name,
      avatar: u.avatar,
      points: u.points,
      wallet: u.wallet,
      holdUsd: el.holdUsd,
      canRace: el.ok,
      raceBlock: el.reason,
      dailyAt: u.daily_at + 20 * 3600_000,
      tickets: this.ticketsLeft(u.id),
      skins: this.ownedSkins(u.id),
      skin: this.chosenSkin(u.id),
    };
  }

  private async walletVerify(u: UserRow, b: { address?: string; signature?: string }): Promise<Response> {
    const address = String(b.address ?? '');
    if (!isSolanaAddress(address)) return fail('That is not a Solana address.');
    const row = this.sql.exec('SELECT nonce, ts FROM nonces WHERE uid = ?', u.id).toArray()[0] as { nonce: string; ts: number } | undefined;
    if (!row || Date.now() - row.ts > 10 * 60_000) return fail('The signing request expired. Try again.');
    const ok = await verifyWalletSignature(address, walletMessage(u.id, row.nonce), String(b.signature ?? ''));
    if (!ok) return fail('The signature did not match that wallet.');
    const taken = this.sql.exec('SELECT id FROM users WHERE wallet = ? AND id != ?', address, u.id).toArray();
    if (taken.length) return fail('That wallet is already linked to another account.');
    this.sql.exec('DELETE FROM nonces WHERE uid = ?', u.id);
    this.sql.exec('UPDATE users SET wallet = ?, hold_usd = NULL, hold_at = NULL WHERE id = ?', address, u.id);
    return json(await this.me(this.user(u.id)!, true));
  }

  // ================================================================== race tickets (game coin)
  private ticketsLeft(uid: string): number {
    return Number(this.sql.exec('SELECT COUNT(*) AS n FROM tickets WHERE uid = ? AND used_ref IS NULL', uid).one().n);
  }

  /** Start a purchase: the memo the payment must carry (ties the on-chain transfer to this account). */
  private ticketIntent(u: UserRow): Response {
    const t = this.cfg.tickets;
    if (!t) return fail('Coin tickets are not set up on this server.');
    const memo = `RaceTrench ticket ${randomToken(9)}`;
    this.sql.exec('INSERT OR REPLACE INTO ticket_memos (uid, memo, ts) VALUES (?, ?, ?)', u.id, memo, Date.now());
    return json({ memo, ...publicTickets(t) });
  }

  /** The player paid: check the transaction on-chain and credit one ticket (once per signature). */
  private async ticketClaim(u: UserRow, b: { signature?: string }): Promise<Response> {
    const t = this.cfg.tickets;
    if (!t) return fail('Coin tickets are not set up on this server.');
    const sig = String(b.signature ?? '');
    const seen = this.sql.exec('SELECT uid FROM tickets WHERE sig = ?', sig).toArray()[0] as { uid: string } | undefined;
    if (seen) return seen.uid === u.id ? json({ ok: true, tickets: this.ticketsLeft(u.id) }) : fail('That payment was already used.');
    const row = this.sql.exec('SELECT memo, ts FROM ticket_memos WHERE uid = ?', u.id).toArray()[0] as { memo: string; ts: number } | undefined;
    if (!row || Date.now() - row.ts > 30 * 60_000) return fail('The ticket purchase expired. Start again.');
    const paid = await verifyTicketPayment(t, sig, row.memo);
    if (!paid) return json({ ok: false, pending: true }); // not confirmed yet: the client retries
    this.state.storage.transactionSync(() => {
      this.sql.exec('INSERT OR IGNORE INTO tickets (sig, uid, wallet, amount, ts) VALUES (?, ?, ?, ?, ?)', sig, u.id, paid.wallet, paid.amount, Date.now());
      this.sql.exec('DELETE FROM ticket_memos WHERE uid = ?', u.id);
    });
    return json({ ok: true, tickets: this.ticketsLeft(u.id) });
  }

  // ================================================================== racer skins (game coin)
  private ownedSkins(uid: string): string[] {
    const bought = new Set(this.sql.exec('SELECT skin FROM skins WHERE uid = ?', uid).toArray().map((r) => String(r.skin)));
    return SKINS.filter((s) => s.price === 0 || bought.has(s.id)).map((s) => s.id);
  }

  private chosenSkin(uid: string): string {
    const row = this.sql.exec('SELECT skin FROM skin_choice WHERE uid = ?', uid).toArray()[0] as { skin: string } | undefined;
    return row && this.ownedSkins(uid).includes(row.skin) ? row.skin : DEFAULT_SKIN;
  }

  private skinSelect(u: UserRow, b: { skin?: string }): Response {
    if (!isSkin(b.skin)) return fail('Unknown skin.');
    if (!this.ownedSkins(u.id).includes(b.skin)) return fail('Buy this skin first.');
    this.sql.exec('INSERT OR REPLACE INTO skin_choice (uid, skin) VALUES (?, ?)', u.id, b.skin);
    return json({ ok: true, skin: b.skin, skins: this.ownedSkins(u.id) });
  }

  /** Start buying a skin: same coin payment as a ticket, with its own memo and price. */
  private skinIntent(u: UserRow, b: { skin?: string }): Response {
    const t = this.cfg.tickets;
    if (!t) return fail('Coin payments are not set up on this server.');
    if (!isSkin(b.skin)) return fail('Unknown skin.');
    const skin = skinById(b.skin);
    if (this.ownedSkins(u.id).includes(skin.id)) return fail('You already own this skin.');
    const memo = `RaceTrench skin ${skin.id} ${randomToken(9)}`;
    this.sql.exec('INSERT OR REPLACE INTO skin_memos (uid, skin, memo, ts) VALUES (?, ?, ?, ?)', u.id, skin.id, memo, Date.now());
    return json({ memo, ...publicTickets(t), price: skin.price });
  }

  /** The player paid for a skin: check it on-chain, unlock it and put it on. */
  private async skinClaim(u: UserRow, b: { signature?: string }): Promise<Response> {
    const t = this.cfg.tickets;
    if (!t) return fail('Coin payments are not set up on this server.');
    const sig = String(b.signature ?? '');
    const seen = this.sql.exec('SELECT uid FROM skins WHERE sig = ?', sig).toArray()[0] as { uid: string } | undefined;
    const seenTicket = this.sql.exec('SELECT uid FROM tickets WHERE sig = ?', sig).toArray().length > 0;
    if (seen?.uid === u.id) return json({ ok: true, skin: this.chosenSkin(u.id), skins: this.ownedSkins(u.id) });
    if (seen || seenTicket) return fail('That payment was already used.');
    const row = this.sql.exec('SELECT skin, memo, ts FROM skin_memos WHERE uid = ?', u.id).toArray()[0] as { skin: string; memo: string; ts: number } | undefined;
    if (!row || Date.now() - row.ts > 30 * 60_000) return fail('The skin purchase expired. Start again.');
    const skin = skinById(row.skin);
    const paid = await verifyTicketPayment({ ...t, price: skin.price }, sig, row.memo);
    if (!paid) return json({ ok: false, pending: true }); // not confirmed yet: the client retries
    this.state.storage.transactionSync(() => {
      this.sql.exec('INSERT OR IGNORE INTO skins (uid, skin, sig, wallet, amount, ts) VALUES (?, ?, ?, ?, ?, ?)', u.id, skin.id, sig, paid.wallet, paid.amount, Date.now());
      this.sql.exec('INSERT OR REPLACE INTO skin_choice (uid, skin) VALUES (?, ?)', u.id, skin.id);
      this.sql.exec('DELETE FROM skin_memos WHERE uid = ?', u.id);
    });
    return json({ ok: true, skin: skin.id, skins: this.ownedSkins(u.id) });
  }

  /** Give back tickets held for a race that this player didn't end up driving in. */
  private returnTicket(uid: string, ref: string) {
    this.sql.exec('UPDATE tickets SET used_ref = NULL WHERE uid = ? AND used_ref = ?', uid, ref);
  }

  private leaderboard() {
    return this.sql
      .exec("SELECT name, handle, avatar, kind, points FROM users ORDER BY points DESC, created ASC LIMIT 50")
      .toArray();
  }

  // ================================================================== betting markets
  private market(id: string) {
    const m = this.sql.exec('SELECT * FROM markets WHERE id = ?', id).toArray()[0] as
      | { id: string; kind: string; title: string; status: string; closes_at: number | null; settle_after: number | null; picks: string; drivers: string; winner: string | null }
      | undefined;
    if (!m) return null;
    // close lazily once the closing time passed
    if (m.status === 'open' && m.closes_at && Date.now() >= m.closes_at) {
      this.sql.exec("UPDATE markets SET status = 'closed' WHERE id = ?", id);
      m.status = 'closed';
    }
    return { ...m, picks: JSON.parse(m.picks) as MarketPick[], drivers: JSON.parse(m.drivers) as string[] };
  }

  private pools(id: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.sql.exec('SELECT pick, SUM(amount) AS s FROM bets WHERE market = ? GROUP BY pick', id).toArray()) out[String(r.pick)] = Number(r.s);
    return out;
  }

  private async marketView(id: string, s: Session | null) {
    const m = this.market(id);
    if (!m) return { market: null };
    const pools = this.pools(id);
    for (const p of m.picks) pools[p.id] ??= 0;
    const mine = s ? this.sql.exec('SELECT pick, amount, payout FROM bets WHERE market = ? AND uid = ? ORDER BY id', id, s.uid).toArray() : [];
    return {
      market: { id: m.id, kind: m.kind, title: m.title, status: m.status, closesAt: m.closes_at, picks: m.picks, winner: m.winner },
      pools,
      odds: poolOdds(pools, this.cfg.points.rakePct),
      total: Object.values(pools).reduce((a, b) => a + b, 0),
      mine,
      youDrive: !!s && m.drivers.includes(s.uid),
      // Live races list the drivers in car order, so a driver's pick id is their index.
      yourPick: s && m.drivers.includes(s.uid) ? String(m.drivers.indexOf(s.uid)) : null,
    };
  }

  private openMarkets(kind: string | null) {
    const rows = this.sql
      .exec("SELECT id, kind, title, status, closes_at FROM markets WHERE status IN ('open','closed') AND (? IS NULL OR kind = ?) ORDER BY created DESC LIMIT 10", kind, kind)
      .toArray();
    return rows;
  }

  private async bet(u: UserRow, b: { market?: string; pick?: string; amount?: number }): Promise<Response> {
    const m = this.market(String(b.market ?? ''));
    if (!m) return fail('No such market.');
    if (m.status !== 'open') return fail('Betting has closed for this race.');
    const pick = String(b.pick ?? '');
    if (!m.picks.some((p) => p.id === pick)) return fail('Pick a driver from this race.');
    // Drivers may back themselves (never a rival: that would pay them to lose).
    if (m.drivers.includes(u.id) && pick !== String(m.drivers.indexOf(u.id))) return fail("You're driving in this race: you can only bet on yourself.");
    const amount = Math.floor(Number(b.amount));
    const P = this.cfg.points;
    if (!(amount >= P.betMin)) return fail(`Minimum bet is ${P.betMin} points.`);
    const already = Number(this.sql.exec('SELECT COALESCE(SUM(amount), 0) AS s FROM bets WHERE market = ? AND uid = ?', m.id, u.id).one().s);
    if (already + amount > P.betMax) return fail(`Maximum ${P.betMax} points per race (you have ${already} on it).`);
    const ok = this.state.storage.transactionSync(() => {
      if (!this.charge(u.id, amount, 'bet', m.id)) return false;
      this.sql.exec('INSERT INTO bets (market, uid, pick, amount, ts) VALUES (?, ?, ?, ?, ?)', m.id, u.id, pick, amount, Date.now());
      return true;
    });
    if (!ok) return fail('Not enough points.');
    return json({ ok: true, points: this.user(u.id)!.points, view: await this.marketView(m.id, { uid: u.id, name: u.name, kind: u.kind, exp: 0 }) });
  }

  /** Pay out a market (winner = pick id), or refund everything (winner = null / void). */
  private settleMarket(id: string, winner: string | null, voided = false) {
    const m = this.market(id);
    if (!m || m.status === 'settled' || m.status === 'void') return { ok: false };
    const bets = this.sql.exec('SELECT id, uid, pick, amount FROM bets WHERE market = ?', id).toArray() as { id: number; uid: string; pick: string; amount: number }[];
    const res = settlePool(bets, voided ? null : winner, this.cfg.points.rakePct);
    this.state.storage.transactionSync(() => {
      for (const [uid, pts] of res.payouts) this.credit(uid, pts, res.refunded ? 'bet refund' : 'bet won', id);
      // record each bet's share for "my bets"
      for (const b of bets) {
        const won = !res.refunded && b.pick === winner;
        const winStake = bets.filter((x) => x.pick === winner).reduce((s, x) => s + x.amount, 0);
        const payout = res.refunded ? b.amount : won ? Math.floor(((bets.reduce((s, x) => s + x.amount, 0) * (100 - this.cfg.points.rakePct)) / 100) * (b.amount / winStake)) : 0;
        this.sql.exec('UPDATE bets SET payout = ? WHERE id = ?', payout, b.id);
      }
      this.sql.exec('UPDATE markets SET status = ?, winner = ?, settled = ? WHERE id = ?', voided ? 'void' : 'settled', winner, Date.now(), id);
    });
    return { ok: true, refunded: res.refunded, rake: res.rake };
  }

  // ================================================================== internal (live race room)
  private async internal(p: string, req: Request): Promise<Response> {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const now = Date.now();
    switch (p) {
      case '/internal/upsert-x':
        return json(this.upsertX(String(b.id), String(b.handle), String(b.name), b.avatar ? String(b.avatar) : null));
      case '/internal/eligibility': {
        const u = this.user(String(b.uid));
        if (!u) return json({ ok: false, reason: 'Account not found. Sign in again.' });
        const el = await this.eligibility(u);
        return json({ ok: el.ok, reason: el.reason, points: u.points, skin: this.chosenSkin(u.id) });
      }
      case '/internal/charge': {
        const ok = this.state.storage.transactionSync(() => this.charge(String(b.uid), Number(b.amount), String(b.reason), b.ref ? String(b.ref) : null));
        return json({ ok, points: this.user(String(b.uid))?.points ?? 0 });
      }
      case '/internal/credit':
        this.state.storage.transactionSync(() => this.credit(String(b.uid), Number(b.amount), String(b.reason), b.ref ? String(b.ref) : null));
        return json({ ok: true });
      case '/internal/balance':
        return json({ points: this.user(String(b.uid))?.points ?? 0 });
      case '/internal/live/enter': {
        // Lobby entry: entry fee (goes into the pot) + optional priority pass (not part of the pot).
        const ref = String(b.ref),
          uid = String(b.uid);
        const fee = Math.max(0, Math.floor(Number(b.fee))),
          prio = Math.max(0, Math.floor(Number(b.priorityFee ?? 0)));
        let needTicket = false;
        const ok = this.state.storage.transactionSync(() => {
          const pot = this.livePot(ref) ?? { status: 'lobby', entries: {} as Record<string, LiveEntry> };
          if (pot.status !== 'lobby' || pot.entries[uid]) return false;
          // With coin tickets on, a seat also takes one of your tickets (given back if you don't race).
          if (this.cfg.tickets) {
            const t = this.sql.exec('SELECT sig FROM tickets WHERE uid = ? AND used_ref IS NULL ORDER BY ts LIMIT 1', uid).toArray()[0] as { sig: string } | undefined;
            if (!t) {
              needTicket = true;
              return false;
            }
            if (!this.charge(uid, fee + prio, prio ? 'race entry + priority pass' : 'race entry', ref)) return false;
            this.sql.exec('UPDATE tickets SET used_ref = ? WHERE sig = ?', ref, t.sig);
          } else if (!this.charge(uid, fee + prio, prio ? 'race entry + priority pass' : 'race entry', ref)) return false;
          pot.entries[uid] = { fee, prio };
          this.saveLivePot(ref, pot.status, pot.entries, now);
          return true;
        });
        return json({ ok, needTicket, points: this.user(uid)?.points ?? 0, tickets: this.ticketsLeft(uid) });
      }
      case '/internal/live/leave': {
        const ref = String(b.ref),
          uid = String(b.uid);
        const ok = this.state.storage.transactionSync(() => {
          const pot = this.livePot(ref);
          const e = pot?.entries[uid];
          if (!pot || pot.status !== 'lobby' || !e) return false;
          this.credit(uid, e.fee + e.prio, 'race entry refund', ref);
          this.returnTicket(uid, ref);
          delete pot.entries[uid];
          this.saveLivePot(ref, pot.status, pot.entries, now);
          return true;
        });
        return json({ ok, points: this.user(uid)?.points ?? 0 });
      }
      case '/internal/live/start': {
        // Lights out: the drivers on the grid make the pot; anyone recorded but not racing is refunded.
        const ref = String(b.ref);
        const racing = new Set((b.uids as string[]) ?? []);
        const pot = this.state.storage.transactionSync(() => {
          const p = this.livePot(ref);
          if (!p || p.status !== 'lobby') return 0;
          for (const [uid, e] of Object.entries(p.entries))
            if (!racing.has(uid)) {
              this.credit(uid, e.fee + e.prio, 'race entry refund', ref);
              this.returnTicket(uid, ref);
              delete p.entries[uid];
            }
          this.saveLivePot(ref, 'open', p.entries, now);
          return Object.values(p.entries).reduce((sum, e) => sum + e.fee, 0);
        });
        return json({ pot });
      }
      case '/internal/live/finish': {
        const ref = String(b.ref);
        const p = this.livePot(ref);
        if (!p || p.status !== 'open') return json({ ok: false });
        const placings = ((b.placings as string[]) ?? []).filter((uid) => p.entries[uid]);
        const total = Object.values(p.entries).reduce((sum, e) => sum + e.fee, 0);
        const split = prizeSplit(total, placings.length);
        this.state.storage.transactionSync(() => {
          placings.forEach((uid, i) => this.credit(uid, split[i], `race prize P${i + 1}`, ref));
          this.saveLivePot(ref, 'paid', p.entries, now);
        });
        return json({ ok: true, pot: total, prizes: placings.map((uid, i) => ({ uid, points: split[i] })) });
      }
      case '/internal/live/void':
        return json(this.voidLivePot(String(b.ref)));
      case '/internal/market/open': {
        const id = String(b.id);
        this.sql.exec(
          "INSERT OR IGNORE INTO markets (id, kind, title, status, closes_at, settle_after, picks, drivers, created) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)",
          id,
          String(b.kind ?? 'live'),
          String(b.title ?? id),
          b.closesAt ? Number(b.closesAt) : null,
          b.settleAfter ? Number(b.settleAfter) : null,
          JSON.stringify(b.picks ?? []),
          JSON.stringify(b.drivers ?? []),
          now,
        );
        return json({ ok: true });
      }
      case '/internal/market/close':
        this.sql.exec("UPDATE markets SET status = 'closed' WHERE id = ? AND status = 'open'", String(b.id));
        return json({ ok: true });
      case '/internal/market/settle':
        return json(this.settleMarket(String(b.id), b.winner === null || b.winner === undefined ? null : String(b.winner), !!b.void));
    }
    return fail('Not found', 404);
  }

  private livePot(ref: string): { status: string; entries: Record<string, LiveEntry> } | null {
    const r = this.sql.exec('SELECT status, entries FROM live_pots WHERE ref = ?', ref).toArray()[0] as { status: string; entries: string } | undefined;
    return r ? { status: r.status, entries: JSON.parse(r.entries) as Record<string, LiveEntry> } : null;
  }

  private saveLivePot(ref: string, status: string, entries: Record<string, LiveEntry>, now: number) {
    const pot = Object.values(entries).reduce((sum, e) => sum + e.fee, 0);
    this.sql.exec(
      'INSERT INTO live_pots (ref, status, fee, entries, pot, created) VALUES (?, ?, 0, ?, ?, ?) ON CONFLICT(ref) DO UPDATE SET status = excluded.status, entries = excluded.entries, pot = excluded.pot',
      ref,
      status,
      JSON.stringify(entries),
      pot,
      now,
    );
  }

  /** Refund every entry (fee + priority pass) of a race that never finished. */
  private voidLivePot(ref: string) {
    const p = this.livePot(ref);
    if (!p || (p.status !== 'lobby' && p.status !== 'open')) return { ok: false };
    this.state.storage.transactionSync(() => {
      for (const [uid, e] of Object.entries(p.entries)) {
        this.credit(uid, e.fee + e.prio, 'race entry refund', ref);
        this.returnTicket(uid, ref);
      }
      this.sql.exec("UPDATE live_pots SET status = 'refunded' WHERE ref = ?", ref);
    });
    return { ok: true };
  }

  // ================================================================== background: league markets + clean-up
  private async ensureAlarm() {
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + 5_000);
  }

  async alarm() {
    const now = Date.now();
    // Live pots whose race never finished (server restarted mid-race): refund the entry fees.
    for (const r of this.sql.exec("SELECT ref FROM live_pots WHERE status IN ('lobby','open') AND created < ?", now - LIVE_POT_TIMEOUT_MS).toArray()) this.voidLivePot(String(r.ref));
    for (const r of this.sql.exec("SELECT id FROM markets WHERE kind = 'live' AND status IN ('open','closed') AND created < ?", now - LIVE_POT_TIMEOUT_MS).toArray())
      this.settleMarket(String(r.id), null, true);
    if (this.cfg.supabase) {
      try {
        await this.syncLeagueMarkets(now);
      } catch {
        /* Supabase unreachable: try again next minute */
      }
    }
    // Keep ticking while people are around (or bets are waiting to be settled).
    const pending = Number(this.sql.exec("SELECT COUNT(*) AS n FROM markets WHERE status IN ('open','closed')").one().n);
    if (pending > 0 || now - this.lastActivity < 3600_000) await this.state.storage.setAlarm(now + 60_000);
  }

  private async supa<T>(path: string, body?: unknown): Promise<T> {
    const s = this.cfg.supabase!;
    const r = await fetch(`${s.url}/rest/v1/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { apikey: s.key, authorization: `Bearer ${s.key}`, 'content-type': 'application/json', prefer: 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    return (await r.json()) as T;
  }

  // ================================================================== player agents (AI League)
  // Submissions go to Supabase `agent_submissions`; the scheduler smoke-tests them in the sandbox and
  // gives valid ones seats in upcoming AI League races.
  private async myAgents(u: UserRow) {
    if (!this.cfg.supabase) return { enabled: false, agents: [] };
    const agents = await this.supa<unknown[]>(`agent_submissions?select=id,name,status,error,created_at,model&owner=eq.${encodeURIComponent(u.id)}&order=created_at.desc&limit=10`);
    return { enabled: true, agents };
  }

  private async submitAgent(u: UserRow, b: { name?: string; code?: string }): Promise<Response> {
    if (!this.cfg.supabase) return fail('The AI League database is not set up on this server.');
    const el = await this.eligibility(u);
    if (!el.ok) return fail(el.reason ?? 'Your account can’t enter agents yet.');
    const name = cleanName(b.name);
    const code = String(b.code ?? '');
    if (!name) return fail('Give your agent a name (letters and numbers, up to 16).');
    if (!/function\s+drive\s*\(/.test(code)) return fail('Your code needs a function drive(state) { … }.');
    if (new TextEncoder().encode(code).length > AGENT_MAX_BYTES) return fail(`Code is limited to ${AGENT_MAX_BYTES / 1000} KB.`);
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const recent = await this.supa<unknown[]>(`agent_submissions?select=id&owner=eq.${encodeURIComponent(u.id)}&created_at=gte.${encodeURIComponent(since)}`);
    if (recent.length >= AGENT_PER_DAY) return fail(`You can submit ${AGENT_PER_DAY} agents a day. Try again tomorrow.`);
    const handle = u.handle ?? u.name;
    const rows = await this.supa<unknown[]>('agent_submissions', { owner: u.id, owner_name: handle, name, code, model: `agent:@${handle}/${name}`, status: 'pending' });
    return json({ ok: true, agent: rows[0] ?? null });
  }

  /** Open a pool market for each upcoming AI League race; settle the ones that finished. */
  private async syncLeagueMarkets(now: number) {
    const from = new Date(now - 5 * 60_000).toISOString();
    const races = await this.supa<{ id: number; start_at: string; ends_at: string | null; race_entries: { car: number; name: string; color: string }[] }[]>(
      `races?select=id,start_at,ends_at,race_entries(car,name,color)&start_at=gte.${encodeURIComponent(from)}&order=start_at.asc&limit=4`,
    );
    for (const r of races) {
      const start = Date.parse(r.start_at);
      const closes = start - LEAGUE_COUNTDOWN_MS; // the seed (and so the track) is revealed at slot start
      if (closes > now && r.race_entries?.length >= 2)
        this.sql.exec(
          "INSERT OR IGNORE INTO markets (id, kind, title, status, closes_at, settle_after, picks, drivers, created) VALUES (?, 'league', ?, 'open', ?, ?, ?, '[]', ?)",
          `league:${r.id}`,
          `AI League race #${r.id}`,
          closes,
          r.ends_at ? Date.parse(r.ends_at) : start + 240_000,
          JSON.stringify(r.race_entries.sort((a, b) => a.car - b.car).map((e) => ({ id: String(e.car), name: e.name, color: e.color }))),
          now,
        );
    }
    const due = this.sql.exec("SELECT id FROM markets WHERE kind = 'league' AND status IN ('open','closed') AND settle_after IS NOT NULL AND settle_after < ?", now).toArray();
    for (const d of due) {
      const raceId = String(d.id).split(':')[1];
      const res = await this.supa<{ car: number; position: number }[]>(`race_results?select=car,position&race_id=eq.${raceId}&position=eq.1`);
      if (res.length) this.settleMarket(String(d.id), String(res[0].car));
      else if (now - Number(this.sql.exec('SELECT settle_after AS s FROM markets WHERE id = ?', String(d.id)).one().s) > 3600_000) this.settleMarket(String(d.id), null, true);
    }
  }
}
