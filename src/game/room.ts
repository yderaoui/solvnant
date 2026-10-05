// The live race room: a Cloudflare Durable Object that owns the authoritative race.
// Every slot: lobby (signed-in players join, up to 10) -> lights out -> race (60 Hz physics,
// 20 Hz snapshots to everyone) -> results. Empty grid slots are filled with native bots.
// Human inputs are recorded so any live race can be replayed exactly from seed + input log.
//
// Phase 2/3 rules (points are play money, kept by the Hub):
//  - you must be signed in (X, or a guest while X isn't configured) and eligible to drive
//  - entry fee goes into the prize pot; 60/30/10 to the best three human drivers; refunded if you leave
//  - max 10 cars; fair rotation (last round's racers give their seat to newcomers); a waitlist when full
//  - priority pass: a guaranteed seat that can't be bumped (limited per race)
//  - spectators can bet on races with a human in them; bets close when the leader has done 40%
import { RaceSim, type Entry, type RaceEvent } from '../sim/race';
import { PHYS } from '../sim/physics';
import { FLAG, SIM_VERSION } from '../sim/race';
import { HOUSE_BOTS } from '../sim/fallbackDriver';
import { generateTrack, lapsFor } from '../sim/track';
import { COUNTDOWN_MS, MAX_RACE_SECONDS, SLOT_MS } from '../sim/schedule';
import { readConfig, type GameConfig } from './config';
import { verifySession } from './auth';
import {
  CAR_SNAP_STRIDE,
  MAX_PLAYERS,
  MIN_GRID,
  PLAYER_COLORS,
  SNAP_HZ,
  type ClientMsg,
  type LobbyEntry,
  type RecentWinner,
  type Phase,
  type RoomInfo,
  type ServerMsg,
} from './protocol';

interface Conn {
  ws: WebSocket;
  id: string | null; // account uid when signed in, else "anon:<browser id>"
  uid: string | null;
  name: string;
  msgs: number; // messages in the current second (rate limit)
  windowStart: number;
}

interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export class GameRoom {
  private conns = new Set<Conn>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private slot = -1;
  private phase: Phase = 'lobby';
  private seed = '';
  private laps = 1;
  private startAt = 0;
  private players: LobbyEntry[] = []; // seated humans for this slot
  private waitlist: LobbyEntry[] = [];
  private pending = new Set<string>(); // joins/leaves waiting on the Hub
  private raceEntries: LobbyEntry[] = [];
  private sim: RaceSim | null = null;
  private carOf = new Map<string, number>();
  private lastSnap = 0;
  private sentEvents = 0;
  private lastRacers = new Set<string>(); // who raced in the previous slot (back-to-back rule)
  private snapState: { tick: number; rt: number; c: number[]; order: number[] } | null = null;
  private lastResults: { results: ReturnType<RaceSim['results']>; duration: number } | null = null;
  private market: string | null = null;
  private betsOpen = false;
  private prizes: { name: string; points: number }[] | null = null;
  private replayId: number | null = null;

  // Round timing (overridable for testing: SLOT_SECONDS / LOBBY_SECONDS vars)
  private slotMs = SLOT_MS;
  private lobbyMs = COUNTDOWN_MS;
  private maxRace = MAX_RACE_SECONDS;
  private cfg: GameConfig;
  private hubNs: DONamespace | null;

  private recent: RecentWinner[] = [];
  private storage: { get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void> } | null = null;

  constructor(state: { storage?: GameRoom['storage'] } | undefined, env: Record<string, unknown>) {
    this.storage = state?.storage ?? null;
    void this.storage?.get('recent').then((r) => {
      if (Array.isArray(r)) this.recent = r as RecentWinner[];
    });
    const vars = Object.fromEntries(Object.entries(env ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    this.cfg = readConfig(vars);
    this.hubNs = (env?.HUB as DONamespace) ?? null;
    if (vars.SLOT_SECONDS) this.slotMs = Number(vars.SLOT_SECONDS) * 1000;
    if (vars.LOBBY_SECONDS) this.lobbyMs = Number(vars.LOBBY_SECONDS) * 1000;
    this.maxRace = Math.min(MAX_RACE_SECONDS, (this.slotMs - this.lobbyMs) / 1000 - 20);
  }

  private slotAt = (ms: number) => Math.floor(ms / this.slotMs);
  private slotStart = (slot: number) => slot * this.slotMs;
  private get ref() {
    return `live:${this.seed}`;
  }

  /** Call the Hub (accounts, points, markets). */
  private async hub<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    if (!this.hubNs) throw new Error('hub not configured');
    const r = await this.hubNs.get(this.hubNs.idFromName('hub')).fetch(new Request(`https://hub${path}`, { method: 'POST', body: JSON.stringify(body) }));
    return (await r.json()) as T;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new (globalThis as any).WebSocketPair();
    const client: WebSocket = pair[0];
    const server: WebSocket = pair[1];
    (server as any).accept();
    const conn: Conn = { ws: server, id: null, uid: null, name: '', msgs: 0, windowStart: Date.now() };
    this.conns.add(conn);
    server.addEventListener('message', (e: MessageEvent) => void this.onMessage(conn, e.data));
    const close = () => {
      this.conns.delete(conn);
      this.markConnected(conn.id);
    };
    server.addEventListener('close', close);
    server.addEventListener('error', close);
    this.ensureLoop();
    return new Response(null, { status: 101, webSocket: client } as any);
  }

  // ------------------------------------------------------------------ messages
  private async onMessage(conn: Conn, data: unknown) {
    const now = Date.now();
    if (now - conn.windowStart > 1000) {
      conn.windowStart = now;
      conn.msgs = 0;
    }
    if (++conn.msgs > 80) return; // flood guard
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (msg.t) {
      case 'hello': {
        const s = await verifySession(msg.token ?? null, this.cfg.sessionSecret);
        conn.uid = s?.uid ?? null;
        conn.name = s?.name ?? '';
        conn.id = conn.uid ?? (`anon:${String(msg.id ?? '').slice(0, 64)}` || null);
        this.syncPhase(Date.now());
        this.markConnected(conn.id);
        this.sendRoom(conn);
        this.catchUp(conn);
        break;
      }
      case 'ping':
        this.send(conn, { t: 'pong', ts: Number(msg.ts) || 0, st: Date.now() });
        break;
      case 'join':
        await this.join(conn, msg.color, !!msg.priority);
        break;
      case 'leave':
        await this.leave(conn);
        break;
      case 'in': {
        if (this.phase !== 'race' || !this.sim || !conn.id) return;
        const car = this.carOf.get(conn.id);
        if (car === undefined) return;
        this.sim.setHumanInput(car, { throttle: Number(msg.th), steer: Number(msg.st), brake: Number(msg.br) });
        break;
      }
    }
  }

  private err(conn: Conn, msg: string) {
    this.send(conn, { t: 'error', msg });
  }

  private async join(conn: Conn, rawColor: unknown, priority: boolean) {
    const uid = conn.uid;
    if (!uid) return this.err(conn, 'Sign in to race (top right).');
    if (this.phase !== 'lobby') return this.err(conn, 'The race has started. Join the next lobby!');
    if (this.players.some((p) => p.id === uid) || this.waitlist.some((p) => p.id === uid) || this.pending.has(uid)) return;
    const slot = this.slot;
    this.pending.add(uid);
    try {
      const el = await this.hub<{ ok: boolean; reason: string | null; points: number }>('/internal/eligibility', { uid });
      if (!el.ok) return this.err(conn, el.reason ?? 'You can’t race yet.');
      const P = this.cfg.points;
      const usedPriority = this.players.filter((p) => p.priority).length;
      if (priority && usedPriority >= P.maxPriority) return this.err(conn, 'No priority passes left for this race.');
      if (el.points < P.entryFee + (priority ? P.priorityFee : 0)) return this.err(conn, `You need ${P.entryFee + (priority ? P.priorityFee : 0)} points to enter.`);

      const taken = new Set([...this.players, ...this.waitlist].map((p) => p.color));
      let color = PLAYER_COLORS.includes(String(rawColor)) ? String(rawColor) : PLAYER_COLORS[0];
      if (taken.has(color)) color = PLAYER_COLORS.find((c) => !taken.has(c)) ?? color;
      const entry: LobbyEntry = { id: uid, name: conn.name, color, kind: 'human', connected: true, priority };

      // Who gives up a seat if the grid is full?
      let bump: LobbyEntry | undefined;
      if (this.players.length >= MAX_PLAYERS) {
        const notPriority = this.players.filter((p) => !p.priority);
        // fair rotation first: someone who raced last round, and the newcomer didn't
        bump = !this.lastRacers.has(uid) ? [...notPriority].reverse().find((p) => this.lastRacers.has(p.id)) : undefined;
        // a priority pass also beats the most recent ordinary entry
        if (!bump && priority) bump = notPriority[notPriority.length - 1];
      }
      if (this.players.length >= MAX_PLAYERS && !bump) {
        if (priority) return this.err(conn, 'The grid is full of priority entries. Catch the next race!');
        this.waitlist.push({ ...entry, priority: false });
        this.send(conn, { t: 'error', msg: 'The grid is full: you’re on the waitlist and get the next free seat.' });
        return this.broadcastRoom();
      }
      // Pay: entry fee into the pot, plus the priority pass (the Hub records both against this race).
      const paid = await this.hub<{ ok: boolean; points: number }>('/internal/live/enter', { ref: this.ref, uid, fee: P.entryFee, priorityFee: priority ? P.priorityFee : 0 });
      if (!paid.ok) return this.err(conn, 'Not enough points.');
      if (this.slot !== slot || this.phase !== 'lobby') {
        // the lobby closed while we were paying: give it back
        await this.refund(entry);
        return this.err(conn, 'Too late, the race started. Join the next lobby!');
      }
      if (bump) await this.toWaitlist(bump, 'Grid full: you raced last round (or lost your seat to a priority pass), so you’re first on the waitlist.');
      this.players.push(entry);
      this.sendPoints(uid);
      this.broadcastRoom();
    } catch {
      this.err(conn, 'The points server is not reachable. Try again in a moment.');
    } finally {
      this.pending.delete(uid);
    }
  }

  /** Move a seated player to the front of the waitlist (fees refunded; they pay again if seated). */
  private async toWaitlist(p: LobbyEntry, why: string) {
    this.players = this.players.filter((x) => x.id !== p.id);
    await this.refund(p);
    this.waitlist.unshift({ ...p, priority: false });
    for (const c of this.conns) if (c.id === p.id) this.err(c, why);
    this.sendPoints(p.id);
  }

  private async refund(p: LobbyEntry) {
    await this.hub('/internal/live/leave', { ref: this.ref, uid: p.id });
  }

  private async leave(conn: Conn) {
    const uid = conn.uid;
    if (!uid || this.phase !== 'lobby' || this.pending.has(uid)) return;
    if (this.waitlist.some((p) => p.id === uid)) {
      this.waitlist = this.waitlist.filter((p) => p.id !== uid);
      return this.broadcastRoom();
    }
    const p = this.players.find((x) => x.id === uid);
    if (!p) return;
    this.pending.add(uid);
    try {
      this.players = this.players.filter((x) => x.id !== uid);
      this.broadcastRoom();
      await this.refund(p);
      this.sendPoints(uid);
      await this.promote();
    } finally {
      this.pending.delete(uid);
    }
  }

  /** A seat opened up: give it to the first person on the waitlist who can still pay. */
  private async promote() {
    while (this.phase === 'lobby' && this.players.length < MAX_PLAYERS && this.waitlist.length) {
      const next = this.waitlist.shift()!;
      const paid = await this.hub<{ ok: boolean }>('/internal/live/enter', { ref: this.ref, uid: next.id, fee: this.cfg.points.entryFee }).catch(() => ({ ok: false }));
      if (!paid.ok) continue;
      this.players.push(next);
      for (const c of this.conns) if (c.id === next.id) this.err(c, 'A seat opened up: you’re on the grid!');
      this.sendPoints(next.id);
    }
    this.broadcastRoom();
  }

  private sendPoints(uid: string) {
    void this.hub<{ points: number }>('/internal/balance', { uid })
      .then((r) => {
        for (const c of this.conns) if (c.uid === uid) this.send(c, { t: 'points', points: r.points });
      })
      .catch(() => {});
  }

  private markConnected(id: string | null) {
    if (!id) return;
    const online = [...this.conns].some((c) => c.id === id);
    for (const list of [this.players, this.raceEntries, this.waitlist]) {
      const e = list.find((p) => p.id === id);
      if (e) e.connected = online;
    }
    // A disconnected driver lifts off and brakes.
    if (!online && this.sim && this.phase === 'race') {
      const car = this.carOf.get(id);
      if (car !== undefined) this.sim.setHumanInput(car, { throttle: 0, steer: 0, brake: 1 });
    }
  }

  // ------------------------------------------------------------------ loop
  private ensureLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => this.loop(), 1000 / 60);
  }

  private loop() {
    if (this.conns.size === 0 && this.phase !== 'race') {
      // Nobody watching and no race running: stop spending CPU. The next visitor restarts the loop.
      clearInterval(this.timer!);
      this.timer = null;
      return;
    }
    const now = Date.now();
    this.syncPhase(now);

    if (this.phase === 'race' && this.sim) {
      const target = Math.floor((now - this.startAt) / 1000 / PHYS.dt);
      let budget = 30; // catch up after a slow tick, but never stall the loop
      while (this.sim.tick < target && !this.sim.done && budget-- > 0) this.sim.stepTick();
      if (now - this.lastSnap >= 1000 / SNAP_HZ || this.sim.done) {
        this.lastSnap = now;
        this.broadcastSnap();
      }
      // Spectator bets close once the leader has done part of the race.
      if (this.betsOpen) {
        const lead = Math.max(...this.sim.carStates().map((c) => c.progress));
        if (lead >= this.cfg.betsCloseAt * this.sim.track.length * this.laps) {
          this.betsOpen = false;
          void this.hub('/internal/market/close', { id: this.market }).catch(() => {});
          this.broadcastRoom();
        }
      }
      if (this.sim.done) void this.finishRace();
    }
  }

  /** Move to the right phase for the current time (new slot -> lobby, lights out -> race). */
  private syncPhase(now: number) {
    const slot = this.slotAt(now);
    if (slot !== this.slot) {
      if (this.phase === 'lobby' && this.seed) void this.hub('/internal/live/void', { ref: this.ref }).catch(() => {}); // missed lights out (room was asleep)
      this.openLobby(slot);
    }
    if (this.phase === 'lobby' && now >= this.startAt) this.startRace();
  }

  private openLobby(slot: number) {
    this.slot = slot;
    this.phase = 'lobby';
    this.lastRacers = new Set(this.raceEntries.filter((e) => e.kind === 'human').map((e) => e.id));
    this.players = [];
    this.waitlist = [];
    this.raceEntries = [];
    this.sim = null;
    this.snapState = null;
    this.lastResults = null;
    this.market = null;
    this.betsOpen = false;
    this.prizes = null;
    this.replayId = null;
    this.carOf.clear();
    const rand = crypto.getRandomValues(new Uint32Array(2)).join('').slice(0, 10);
    this.seed = `live${slot}-${rand}`;
    this.laps = lapsFor(generateTrack(this.seed));
    this.startAt = this.slotStart(slot) + this.lobbyMs;
    this.broadcastRoom();
  }

  private startRace() {
    const humans = this.players.slice(0, MAX_PLAYERS);
    const entries: LobbyEntry[] = [...humans];
    const used = new Set(humans.map((h) => h.color));
    for (let b = 0; entries.length < Math.max(MIN_GRID, humans.length) && b < HOUSE_BOTS.length; b++) {
      const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? '#c2c3c7';
      used.add(color);
      entries.push({ id: `bot:${b}`, name: HOUSE_BOTS[b].name.replace('House Bot ', 'BOT '), color, kind: 'bot', connected: true });
    }
    for (const w of this.waitlist) for (const c of this.conns) if (c.id === w.id) this.err(c, 'No seat this time. You’re first in line for a newcomer seat next race.');
    this.waitlist = [];
    this.raceEntries = entries;
    this.carOf = new Map(humans.map((h, i) => [h.id, i]));
    this.sim = new RaceSim(null, { seed: this.seed, entries: this.simEntries(entries), laps: this.laps, maxTime: this.maxRace, obstacles: true });
    this.sentEvents = 0;
    this.phase = 'race';
    if (humans.length) {
      // The pot is the entry fees paid in the lobby by the drivers who are on the grid.
      void this.hub('/internal/live/start', { ref: this.ref, uids: humans.map((h) => h.id) }).catch(() => {});
      // Spectator betting only on races with a person in them (bots-only races are predictable).
      this.market = this.ref;
      this.betsOpen = true;
      void this.hub('/internal/market/open', {
        id: this.market,
        kind: 'live',
        title: `Live race ${this.slot % 10000}`,
        picks: entries.map((e, i) => ({ id: String(i), name: e.name, color: e.color })),
        drivers: humans.map((h) => h.id),
      }).catch(() => {});
    }
    this.broadcastRoom();
  }

  private simEntries(entries: LobbyEntry[]): Entry[] {
    return entries.map((e) => ({
      name: e.name,
      model: e.kind === 'bot' ? HOUSE_BOTS[Number(e.id.slice(4))].name : `player:${e.name}`,
      color: e.color,
      code: '',
      source: e.kind === 'human' ? 'human' : 'bot',
      botParams: e.kind === 'bot' ? { ...HOUSE_BOTS[Number(e.id.slice(4))].params, grip: HOUSE_BOTS[Number(e.id.slice(4))].params.grip * 0.92 } : undefined,
    }));
  }

  private finishing = false;
  private async finishRace() {
    if (!this.sim || this.phase !== 'race' || this.finishing) return;
    this.finishing = true;
    const sim = this.sim;
    const ref = this.ref;
    this.phase = 'results';
    const results = sim.results();
    const win = results[0];
    const e = this.raceEntries[win.car];
    const humanCount = this.raceEntries.filter((x) => x.kind === 'human').length;
    if (e) {
      this.recent.unshift({ slot: this.slot, name: e.name, color: e.color, kind: e.kind, time: win.finishTime, field: this.raceEntries.length, humans: humanCount, at: Date.now() });
      this.recent = this.recent.slice(0, 5);
      void this.storage?.put('recent', this.recent);
    }
    this.lastResults = { results, duration: sim.t };
    this.broadcast({ t: 'results', results, duration: sim.t });
    this.broadcastRoom();
    try {
      if (humanCount) {
        const placings = results.map((r) => this.raceEntries[r.car]).filter((x) => x?.kind === 'human').map((x) => x.id);
        const out = await this.hub<{ prizes?: { uid: string; points: number }[] }>('/internal/live/finish', { ref, placings });
        this.prizes = (out.prizes ?? []).filter((p) => p.points > 0).map((p) => ({ name: this.raceEntries.find((x) => x.id === p.uid)?.name ?? '?', points: p.points }));
        for (const p of out.prizes ?? []) this.sendPoints(p.uid);
        if (this.market) await this.hub('/internal/market/settle', { id: this.market, winner: String(win.car) });
        this.replayId = await this.persist(sim, results);
      }
    } catch {
      /* the Hub refunds open pots/markets on its own if this never lands */
    } finally {
      this.finishing = false;
      if (this.ref === ref) this.broadcastRoom();
    }
  }

  /** Save the race (seed + who drove + every input change) so it can be replayed and checked. */
  private async persist(sim: RaceSim, results: ReturnType<RaceSim['results']>): Promise<number | null> {
    const s = this.cfg.supabase;
    if (!s) return null;
    const r = await fetch(`${s.url}/rest/v1/live_races`, {
      method: 'POST',
      headers: { apikey: s.key, authorization: `Bearer ${s.key}`, 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify({
        slot: this.slot,
        seed: this.seed,
        laps: this.laps,
        sim_version: SIM_VERSION,
        max_time: this.maxRace,
        started_at: new Date(this.startAt).toISOString(),
        duration: sim.t,
        entries: this.raceEntries.map((e, i) => ({ car: i, name: e.name, color: e.color, kind: e.kind, bot: e.kind === 'bot' ? Number(e.id.slice(4)) : null })),
        input_log: sim.inputLog,
        results: results.map((x) => ({ car: x.car, position: x.position, finished: x.finished, finish_time: x.finishTime, best_lap: x.bestLap, crashed: x.crashed })),
      }),
    });
    if (!r.ok) return null;
    const rows = (await r.json()) as { id: number }[];
    return rows[0]?.id ?? null;
  }

  // ------------------------------------------------------------------ outgoing
  private roomInfo(): RoomInfo {
    const P = this.cfg.points;
    return {
      slot: this.slot,
      phase: this.phase,
      seed: this.seed,
      laps: this.laps,
      startAt: this.startAt,
      slotEnd: this.slotStart(this.slot + 1),
      entries: this.phase === 'lobby' ? this.players : this.raceEntries,
      maxPlayers: MAX_PLAYERS,
      viewers: this.conns.size,
      recent: this.recent,
      waitlist: this.waitlist,
      entryFee: P.entryFee,
      priorityFee: P.priorityFee,
      priorityLeft: Math.max(0, P.maxPriority - this.players.filter((p) => p.priority).length),
      pot: this.phase === 'lobby' ? P.entryFee * this.players.length : P.entryFee * this.raceEntries.filter((e) => e.kind === 'human').length,
      market: this.market,
      betsOpen: this.betsOpen,
      prizes: this.prizes,
      replayId: this.replayId,
    };
  }

  private sendRoom(conn: Conn) {
    const car = conn.id && this.phase !== 'lobby' ? (this.carOf.get(conn.id) ?? null) : null;
    this.send(conn, { t: 'room', room: this.roomInfo(), you: conn.id ?? '', car });
  }

  private broadcastRoom() {
    for (const c of this.conns) this.sendRoom(c);
  }

  private broadcastSnap() {
    const sim = this.sim!;
    const cars = sim.carStates();
    const c: number[] = new Array(cars.length * CAR_SNAP_STRIDE);
    let o = 0;
    for (const car of cars) {
      c[o++] = r2(car.x);
      c[o++] = r2(car.y);
      c[o++] = Math.round(car.h * 10000) / 10000;
      c[o++] = r2(car.vx);
      c[o++] = r2(car.vy);
      c[o++] = r2(car.steer);
      c[o++] = r2(car.slip);
      c[o++] = r2(car.progress);
      c[o++] =
        (car.offTrack ? FLAG.offTrack : 0) |
        (car.stopped ? FLAG.stopped : 0) |
        (car.finished ? FLAG.finished : 0) |
        (car.slipstream ? FLAG.slipstream : 0) |
        (car.brake > 0.1 ? FLAG.braking : 0);
    }
    const ev: RaceEvent[] = sim.events.slice(this.sentEvents);
    this.sentEvents = sim.events.length;
    this.snapState = { tick: sim.tick, rt: r2(sim.t), c, order: sim.standingsNow() };
    this.broadcast({ t: 'snap', ...this.snapState, ev: ev.length ? ev : undefined });
  }

  /** Someone connected mid-race or after it: send where everyone is, fallen trees, and the results. */
  private catchUp(conn: Conn) {
    if (this.phase === 'lobby' || !this.sim || !this.snapState) return;
    const fallen = this.sim.events.filter((e) => e.type === 'tree' && e.down);
    this.send(conn, { t: 'snap', ...this.snapState, ev: fallen.length ? fallen : undefined, catchup: true });
    if (this.phase === 'results' && this.lastResults) this.send(conn, { t: 'results', ...this.lastResults });
  }

  private broadcast(msg: ServerMsg) {
    const s = JSON.stringify(msg);
    for (const c of this.conns) {
      try {
        c.ws.send(s);
      } catch {
        /* closed */
      }
    }
  }

  private send(conn: Conn, msg: ServerMsg) {
    try {
      conn.ws.send(JSON.stringify(msg));
    } catch {
      /* closed */
    }
  }
}
