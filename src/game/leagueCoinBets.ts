import { publicTickets, type GameConfig } from './config';
import { coinActionProblem } from './coinLaunch';
import { randomToken } from './auth';
import { isSolanaAddress, type Payment } from './solana';
import { isLeagueBetMemo } from './purchaseMemo';
import { LEAGUE_BET_MIN_USD, LEAGUE_BET_MAX_USD, LEAGUE_RESULT_TIMEOUT_MS, leaguePaymentInTime, leagueStakeUsd, settleCoinPool } from './leagueCoinPool';

interface Sql { exec(q: string, ...args: unknown[]): { toArray(): Record<string, unknown>[]; one(): Record<string, unknown> } }
interface Pick { id: string; name: string; color: string }
interface Market { id: string; mint: string; revision: string; decimals: number; symbol: string; picks: string; closes_at: number; settle_after: number; status: string; winner: string | null }
interface Bet { sig: string; uid: string; wallet: string; market: string; pick: string; units: string; usd: number; state: string; payout_units: string | null; payout_ref: string | null }
export class CoinBetError extends Error { constructor(message: string, readonly status = 409) { super(message); } }

/** Durable, mint-scoped bets; on-chain transfers go through the existing shared payout queue. */
export class LeagueCoinBets {
  constructor(private sql: Sql, private atomic: <T>(fn: () => T) => T, private config: () => GameConfig, private price: () => Promise<number | null>) {
    sql.exec(`CREATE TABLE IF NOT EXISTS league_coin_markets (
      id TEXT PRIMARY KEY, mint TEXT NOT NULL, revision TEXT NOT NULL, decimals INTEGER NOT NULL,
      symbol TEXT NOT NULL, picks TEXT NOT NULL, closes_at INTEGER NOT NULL, settle_after INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', winner TEXT, settled INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS league_bet_intents (
      memo TEXT PRIMARY KEY, uid TEXT NOT NULL, market TEXT NOT NULL, pick TEXT NOT NULL,
      units TEXT NOT NULL, usd REAL NOT NULL, mint TEXT NOT NULL, revision TEXT NOT NULL,
      created INTEGER NOT NULL, expires INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS league_coin_bets (
      sig TEXT PRIMARY KEY, memo TEXT NOT NULL, uid TEXT NOT NULL, wallet TEXT NOT NULL, market TEXT NOT NULL,
      pick TEXT NOT NULL, units TEXT NOT NULL, usd REAL NOT NULL, state TEXT NOT NULL,
      payout_units TEXT, payout_ref TEXT, reason TEXT, ts INTEGER NOT NULL)`);
    sql.exec('CREATE INDEX IF NOT EXISTS league_coin_bets_market ON league_coin_bets(market, state)');
    sql.exec('CREATE INDEX IF NOT EXISTS league_coin_bets_uid ON league_coin_bets(uid, ts)');
    sql.exec(`CREATE TABLE IF NOT EXISTS league_bet_receipts (
      sig TEXT PRIMARY KEY, uid TEXT NOT NULL, memo TEXT NOT NULL, created INTEGER NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', last_valid INTEGER)`);
    try { sql.exec('ALTER TABLE league_bet_receipts ADD COLUMN last_valid INTEGER'); } catch { /* already present */ }
  }

  enabled() { const c = this.config(); return !!c.leagueCoinBets && !!c.supabase?.anonKey && !!c.tickets; }
  private market(id: string) { return this.sql.exec('SELECT * FROM league_coin_markets WHERE id = ?', id).toArray()[0] as unknown as Market | undefined; }
  private intent(memo: string) { return this.sql.exec('SELECT * FROM league_bet_intents WHERE memo = ?', memo).toArray()[0]; }

  /** Anonymous access must hide both the seed and the precomputed result before taking coins. */
  async privacy(id: string) {
    const s = this.config().supabase;
    const race = /^league:(\d+)$/.exec(id)?.[1];
    if (!s?.anonKey || !race) throw new CoinBetError('Coin betting is not configured for this AI race.');
    const checks = await Promise.all([
      `races?select=id,seed&id=eq.${race}`,
      `race_results?select=car,position&race_id=eq.${race}`,
    ].map(async query => {
      const response = await fetch(`${s.url}/rest/v1/${query}`, { headers: { apikey: s.anonKey!, authorization: `Bearer ${s.anonKey}` }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new CoinBetError('Could not check this race. Coin betting stays closed.');
      const rows = await response.json();
      return Array.isArray(rows) && rows.length === 0;
    }));
    if (!checks.every(Boolean)) throw new CoinBetError('This race was already revealed. Coin bets are closed.');
  }

  async open(id: string, picks: Pick[], closes: number, ends: number) {
    const c = this.config(), t = c.tickets, revision = c.coinLaunch.revision;
    if (!this.enabled() || !t || c.coinLaunch.status !== 'live' || c.coinLaunch.paidEnabled === false || closes <= Date.now() + 10_000) return;
    if (!/^league:\d+$/.test(id) || picks.length < 2 || new Set(picks.map(p => p.id)).size !== picks.length) return;
    const previous = this.market(id);
    if (previous) {
      if (previous.picks !== JSON.stringify(picks) || previous.closes_at !== closes) this.settle(id, null, 'The starting grid changed.');
      return;
    }
    await this.privacy(id);
    if (this.config().coinLaunch.revision !== revision || closes <= Date.now() + 10_000) return;
    this.sql.exec(`INSERT OR IGNORE INTO league_coin_markets (id,mint,revision,decimals,symbol,picks,closes_at,settle_after) VALUES (?,?,?,?,?,?,?,?)`, id, t.mint, c.coinLaunch.revision, t.decimals, t.symbol, JSON.stringify(picks), closes, Math.max(ends, closes + 45_000));
  }

  private readyMarket(id: string): Market {
    const c = this.config(), m = this.market(id);
    if (!this.enabled() || c.coinLaunch.status !== 'live' || c.coinLaunch.paidEnabled === false) throw new CoinBetError('AI coin betting is paused.');
    if (!m || m.mint !== c.tickets?.mint || m.revision !== c.coinLaunch.revision) throw new CoinBetError('No coin-betting market for this race.');
    if (m.status !== 'open' || Date.now() >= m.closes_at) throw new CoinBetError('Betting has closed for this race.');
    return m;
  }

  memoUnits(uid: string, memo: string): string | null {
    const i = this.intent(memo);
    if (!i || i.uid !== uid || Date.now() >= Number(i.expires) || this.sql.exec('SELECT sig FROM league_bet_receipts WHERE memo = ?', memo).toArray().length) return null;
    try { this.readyMarket(String(i.market)); } catch { return null; }
    return String(i.units);
  }

  async validateMemo(uid: string, memo: string) {
    const i = this.intent(memo);
    // A prepared receipt does not invalidate its own final preflight. A second sponsored
    // signature is blocked separately before co-signing, not by this read check.
    if (!i || i.uid !== uid || Date.now() >= Number(i.expires)) throw new CoinBetError('This bet quote expired. Review the next race.');
    this.readyMarket(String(i.market));
    await this.privacy(String(i.market));
    this.readyMarket(String(i.market));
    if (Date.now() >= Number(i.expires)) throw new CoinBetError('This bet quote expired. Nothing was sent.');
  }

  async issue(uid: string, b: { market?: unknown; pick?: unknown; usd?: unknown; coinRevision?: unknown }) {
    const c = this.config(), revision = c.coinLaunch.revision;
    const problem = coinActionProblem(c, b.coinRevision);
    if (problem) throw new CoinBetError(problem);
    const id = String(b.market ?? ''), pick = String(b.pick ?? ''), usd = leagueStakeUsd(b.usd);
    const m = this.readyMarket(id);
    if (m.closes_at - Date.now() < 15_000) throw new CoinBetError('This race is closing. Choose the next race.');
    if (!(JSON.parse(m.picks) as Pick[]).some(p => p.id === pick)) throw new CoinBetError('Choose an AI driver from this race.');
    if (usd === null) throw new CoinBetError(`Choose $${LEAGUE_BET_MIN_USD}–$${LEAGUE_BET_MAX_USD} in whole cents.`, 400);
    const spent = Number(this.sql.exec("SELECT COALESCE(SUM(usd),0) AS n FROM league_coin_bets WHERE market = ? AND uid = ? AND state <> 'refund'", id, uid).one().n);
    if (spent + usd > LEAGUE_BET_MAX_USD + 1e-7) throw new CoinBetError(`Maximum $${LEAGUE_BET_MAX_USD} per AI race.`);
    const recent = Number(this.sql.exec('SELECT COUNT(*) AS n FROM league_bet_intents WHERE uid = ? AND created > ?', uid, Date.now() - 86_400_000).one().n);
    if (recent >= 100) throw new CoinBetError('Daily bet-review limit reached. Try again tomorrow.');
    const [price] = await Promise.all([this.price(), this.privacy(id)]);
    if (!(price && price > 0) || !Number.isFinite(price)) throw new CoinBetError('The live coin price is unavailable. Try again shortly.');
    const raw = Math.ceil(usd / price * 10 ** m.decimals);
    if (!Number.isSafeInteger(raw) || raw <= 0) throw new CoinBetError('Cannot quote this amount. Try a different stake.');
    this.readyMarket(id);
    if (this.config().coinLaunch.revision !== revision) throw new CoinBetError('Coin settings changed. Review again.');
    const now = Date.now(), expires = Math.min(now + 90_000, m.closes_at - 3_000);
    if (expires <= now + 3_000) throw new CoinBetError('This race is closing. Choose the next race.');
    const memo = `PumpKart league bet ${randomToken(12)}`, units = String(raw);
    this.atomic(() => {
      this.sql.exec('INSERT INTO league_bet_intents (memo,uid,market,pick,units,usd,mint,revision,created,expires) VALUES (?,?,?,?,?,?,?,?,?,?)', memo, uid, id, pick, units, usd, m.mint, revision, now, expires);
      this.sql.exec('INSERT INTO pay_memos (memo,uid,ts,price,mint,coin_revision) VALUES (?,?,?,?,?,?)', memo, uid, now, raw / 10 ** m.decimals, m.mint, revision);
    });
    return { ...publicTickets(this.config().tickets!), memo, price: raw / 10 ** m.decimals, entryUnits: units, usd, coinRevision: revision, betMarket: id, betPick: pick, betName: (JSON.parse(m.picks) as Pick[]).find(p => p.id === pick)!.name, expires, closesAt: m.closes_at };
  }

  track(uid: string, signature: string, memo: string, serverLastValid?: number) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) throw new CoinBetError('That is not a transaction signature.', 400);
    const i = this.intent(memo);
    if (!i || i.uid !== uid) throw new CoinBetError('This payment is not for this account.');
    const existing = this.sql.exec('SELECT uid FROM league_bet_receipts WHERE sig = ?', signature).toArray()[0];
    if (existing && existing.uid !== uid) throw new CoinBetError('That receipt belongs to another account.');
    const another = this.sql.exec('SELECT sig FROM league_bet_receipts WHERE memo = ? AND sig <> ?', memo, signature).toArray();
    if (another.length) throw new CoinBetError('This bet already has a signed payment. Check its receipt.');
    this.sql.exec('INSERT OR IGNORE INTO league_bet_receipts (sig,uid,memo,created,last_valid) VALUES (?,?,?,?,?)', signature, uid, memo, Date.now(), serverLastValid ?? null);
  }

  receipts(now: number) {
    const rows = this.sql.exec("SELECT sig,uid,last_valid,created FROM league_bet_receipts WHERE status = 'pending' AND checked < ? ORDER BY checked,created LIMIT 4", now - 10_000).toArray();
    for (const r of rows) this.sql.exec('UPDATE league_bet_receipts SET checked = ? WHERE sig = ?', now, r.sig);
    return rows as unknown as { sig: string; uid: string; last_valid: number | null; created: number }[];
  }
  finishReceipt(sig: string) { this.sql.exec("UPDATE league_bet_receipts SET status = 'done' WHERE sig = ?", sig); }
  used(sig: string) { return this.sql.exec('SELECT uid FROM league_coin_bets WHERE sig = ?', sig).toArray()[0]; }

  claim(uid: string, sig: string, paid: Payment) {
    const memos = paid.memos.filter(isLeagueBetMemo);
    if (memos.length !== 1) throw new CoinBetError('This is not an AI League bet payment.', 400);
    const i = this.intent(memos[0]), c = this.config();
    if (!i || i.uid !== uid) throw new CoinBetError('This payment is not for this account (memo mismatch).', 400);
    if (i.mint !== c.tickets?.mint) throw new CoinBetError('This payment uses an older coin. Contact support with its transaction.');
    if (!paid.units || !/^[1-9]\d*$/.test(paid.units) || !isSolanaAddress(paid.wallet) || paid.payerUnits !== paid.units) throw new CoinBetError('Cannot verify the original payer and exact received coins. Keep the receipt for recovery.');
    if (paid.blockTime === undefined || paid.blockTime === null) return { ok: false, pending: true };
    this.atomic(() => {
      const existing = this.used(sig);
      if (existing) { if (existing.uid !== uid) throw new CoinBetError('That payment was already used.'); return; }
      const m = this.market(String(i.market));
      const usedMemo = this.sql.exec('SELECT sig FROM league_coin_bets WHERE memo = ? AND sig <> ?', memos[0], sig).toArray().length;
      const spent = Number(this.sql.exec("SELECT COALESCE(SUM(usd),0) AS n FROM league_coin_bets WHERE market = ? AND uid = ? AND state <> 'refund'", i.market, uid).one().n);
      // Block times are estimated (https://solana.com/docs/rpc/http/getblocktime).
      // The trusted server must ALSO see a confirmed payment before seed disclosure;
      // a pre-signed wire held until the outcome is known can only receive a refund.
      const accepted = !!m && ['open','closed'].includes(m.status) && Date.now() < m.closes_at && m.mint === i.mint && paid.units === String(i.units) && leaguePaymentInTime(paid.blockTime, Math.min(m.closes_at,Number(i.expires))) && !usedMemo && spent + Number(i.usd) <= LEAGUE_BET_MAX_USD + 1e-7;
      this.sql.exec('INSERT INTO league_coin_bets (sig,memo,uid,wallet,market,pick,units,usd,state,ts) VALUES (?,?,?,?,?,?,?,?,?,?)', sig, memos[0], uid, paid.wallet, i.market, i.pick, paid.units, i.usd, accepted ? 'accepted' : 'refund', Date.now());
      if (!accepted) {
        const reason = !m || !['open','closed'].includes(m.status) || Date.now() > m.settle_after ? 'The race already settled.' : 'The payment was late, duplicated or did not match the reviewed stake.';
        this.refund(sig, reason);
      }
      this.finishReceipt(sig);
    });
    return this.claimView(sig, uid);
  }

  claimView(sig: string, uid: string) {
    const b = this.sql.exec('SELECT * FROM league_coin_bets WHERE sig = ? AND uid = ?', sig, uid).toArray()[0] as unknown as Bet | undefined;
    if (!b) return { ok: false, pending: true };
    return { ok: true, kind: 'bet' as const, accepted: b.state !== 'refund', refunded: b.state === 'refund', market: b.market, pick: b.pick, signature: sig, view: this.view(b.market, uid) };
  }

  private enqueue(ref: string, uid: string, wallet: string, market: string, prize: string, burn = '0', team = '0') {
    const m = this.market(market)!;
    const scale = 10 ** m.decimals;
    this.sql.exec(`INSERT OR IGNORE INTO lobby_payouts (lobby,uid,wallet,prize,burn,team,status,ts,kind,parent_lobby,raw_units) VALUES (?,?,?,?,?,?,'pending',?,'league',?,?)`, ref, uid, wallet, Number(prize) / scale, Number(burn) / scale, Number(team) / scale, Date.now(), market, JSON.stringify({ prize, burn, team }));
  }
  private refund(sig: string, reason: string) {
    const b = this.sql.exec('SELECT * FROM league_coin_bets WHERE sig = ?', sig).toArray()[0] as unknown as Bet;
    const ref = `league-refund:${sig}`;
    this.enqueue(ref, b.uid, b.wallet, b.market, b.units);
    this.sql.exec("UPDATE league_coin_bets SET state = 'refund', payout_units = units, payout_ref = ?, reason = ? WHERE sig = ?", ref, reason, sig);
  }

  settle(id: string, winner: string | null, reason = 'Race cancelled or no winning bets.') {
    const m = this.market(id);
    if (!m || !['open','closed'].includes(m.status)) return;
    if (winner !== null && Date.now() < Math.max(m.closes_at,m.settle_after)) return;
    const picks = JSON.parse(m.picks) as Pick[];
    if (winner !== null && !picks.some(p => p.id === winner)) winner = null;
    this.atomic(() => {
      const bets = this.sql.exec("SELECT * FROM league_coin_bets WHERE market = ? AND state = 'accepted' ORDER BY sig", id).toArray() as unknown as Bet[];
      const result = settleCoinPool(bets.map(b => ({ id: b.sig, pick: b.pick, units: b.units })), winner);
      if (result.refunded) for (const b of bets) this.refund(b.sig, reason);
      else {
        const groups = new Map<string, { uid: string; wallet: string; units: bigint; bets: Bet[] }>();
        for (const b of bets) {
          const units = result.payouts.get(b.sig)!;
          this.sql.exec('UPDATE league_coin_bets SET state = ?, payout_units = ? WHERE sig = ?', b.pick === winner ? 'won' : 'lost', units, b.sig);
          if (BigInt(units) === 0n) continue;
          const key = `${b.uid}:${b.wallet}`;
          const group = groups.get(key) ?? { uid: b.uid, wallet: b.wallet, units: 0n, bets: [] };
          group.units += BigInt(units); group.bets.push(b); groups.set(key, group);
        }
        let feesAssigned = false;
        for (const group of groups.values()) {
          const ref = `league-prize:${id}:${group.bets[0].sig}`;
          this.enqueue(ref, group.uid, group.wallet, id, String(group.units), feesAssigned ? '0' : result.burn, feesAssigned ? '0' : result.team);
          feesAssigned = true;
          for (const b of group.bets) this.sql.exec('UPDATE league_coin_bets SET payout_ref = ? WHERE sig = ?', ref, b.sig);
        }
      }
      this.sql.exec('UPDATE league_coin_markets SET status = ?, winner = ?, settled = ? WHERE id = ?', result.refunded ? 'void' : 'settled', winner, Date.now(), id);
    });
  }

  due(now: number) {
    this.sql.exec("UPDATE league_coin_markets SET status = 'closed' WHERE status = 'open' AND closes_at <= ?", now);
    return this.sql.exec("SELECT id,picks,settle_after FROM league_coin_markets WHERE status = 'closed' AND settle_after <= ? ORDER BY settle_after LIMIT 4", now).toArray();
  }
  expire(now: number) {
    for (const row of this.sql.exec("SELECT id FROM league_coin_markets WHERE status IN ('open','closed') AND settle_after < ?", now - LEAGUE_RESULT_TIMEOUT_MS).toArray()) this.settle(String(row.id), null, 'Race results were not available. Full stake refunded.');
  }
  outstanding() { return Number(this.sql.exec("SELECT COUNT(*) AS n FROM league_coin_markets m WHERE status IN ('open','closed') AND EXISTS (SELECT 1 FROM league_coin_bets b WHERE b.market = m.id AND b.state = 'accepted')").one().n); }
  pending() { return Number(this.sql.exec("SELECT COUNT(*) AS n FROM league_bet_receipts WHERE status = 'pending' AND created > ?", Date.now() - 15 * 60_000).one().n) + this.outstanding(); }

  view(id: string, uid: string | null) {
    const m = this.market(id);
    if (!m) return { market: null };
    const scale = 10 ** m.decimals, pools: Record<string, number> = {};
    for (const p of JSON.parse(m.picks) as Pick[]) pools[p.id] = 0;
    for (const r of this.sql.exec("SELECT pick,units FROM league_coin_bets WHERE market = ? AND state <> 'refund'", id).toArray()) pools[String(r.pick)] += Number(r.units) / scale;
    const total = Object.values(pools).reduce((a,b) => a+b,0);
    const c = this.config();
    const status = m.status === 'open' && Date.now() >= m.closes_at ? 'closed' : m.status;
    const mine = uid ? this.sql.exec('SELECT b.*, p.status AS payment_status, p.sig AS payout_sig FROM league_coin_bets b LEFT JOIN lobby_payouts p ON p.lobby = b.payout_ref WHERE b.market = ? AND b.uid = ? ORDER BY b.ts', id, uid).toArray().map(b => ({ pick: b.pick, amount: Number(b.units)/scale, payout: b.payout_units === null ? null : Number(b.payout_units)/scale, state: b.state, signature: b.sig, paymentStatus: b.payment_status, payoutSignature: b.payout_sig, reason: b.reason })) : [];
    return { market: { id,kind:'league',title:`AI League race #${id.split(':')[1]}`,status,closesAt:m.closes_at,picks:JSON.parse(m.picks) as Pick[],winner:m.winner }, pools, total, odds: Object.fromEntries(Object.entries(pools).map(([p,v])=>[p,v>0?total*.8/v:null])), mine, youDrive:false,yourPick:null, currency:'coin', symbol:m.symbol, mint:m.mint, cluster:c.tickets?.cluster, enabled:this.enabled()&&c.coinLaunch.status==='live'&&c.coinLaunch.paidEnabled!==false&&m.revision===c.coinLaunch.revision, minUsd:LEAGUE_BET_MIN_USD,maxUsd:LEAGUE_BET_MAX_USD,split:{winners:80,burn:15,team:5} };
  }
  history(uid: string) {
    const rows = this.sql.exec('SELECT market,MAX(ts) AS recent FROM league_coin_bets WHERE uid = ? GROUP BY market ORDER BY recent DESC LIMIT 20', uid).toArray();
    return rows.map(r => this.view(String(r.market), uid));
  }
}
