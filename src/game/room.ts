// The live race room: a Cloudflare Durable Object that owns the authoritative race.
// Every 5-minute slot: lobby (players join, up to 10) -> lights out -> race (60 Hz physics,
// 20 Hz snapshots to everyone) -> results. Empty grid slots are filled with native bots.
// Human inputs are recorded so any live race can be replayed exactly from seed + input log.
import { RaceSim, type Entry, type RaceEvent } from '../sim/race';
import { PHYS } from '../sim/physics';
import { FLAG } from '../sim/race';
import { HOUSE_BOTS } from '../sim/fallbackDriver';
import { generateTrack, lapsFor } from '../sim/track';
import { COUNTDOWN_MS, MAX_RACE_SECONDS, SLOT_MS } from '../sim/schedule';
import {
  CAR_SNAP_STRIDE,
  MAX_PLAYERS,
  MIN_GRID,
  PLAYER_COLORS,
  SNAP_HZ,
  cleanName,
  type ClientMsg,
  type LobbyEntry,
  type RecentWinner,
  type Phase,
  type RoomInfo,
  type ServerMsg,
} from './protocol';

interface Conn {
  ws: WebSocket;
  id: string | null;
  msgs: number; // messages in the current second (rate limit)
  windowStart: number;
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
  private players: LobbyEntry[] = []; // humans who joined this slot's lobby
  private raceEntries: LobbyEntry[] = [];
  private sim: RaceSim | null = null;
  private carOf = new Map<string, number>();
  private lastSnap = 0;
  private sentEvents = 0;
  private lastRacers = new Set<string>(); // who raced in the previous slot (back-to-back rule)
  private snapState: { tick: number; rt: number; c: number[]; order: number[] } | null = null;
  private lastResults: { results: ReturnType<RaceSim['results']>; duration: number } | null = null;

  // Round timing (overridable for testing: SLOT_SECONDS / LOBBY_SECONDS vars)
  private slotMs = SLOT_MS;
  private lobbyMs = COUNTDOWN_MS;
  private maxRace = MAX_RACE_SECONDS;

  private recent: RecentWinner[] = [];
  private storage: { get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void> } | null = null;

  constructor(state: { storage?: GameRoom['storage'] } | undefined, env: Record<string, string | undefined>) {
    this.storage = state?.storage ?? null;
    void this.storage?.get('recent').then((r) => {
      if (Array.isArray(r)) this.recent = r as RecentWinner[];
    });
    if (env?.SLOT_SECONDS) this.slotMs = Number(env.SLOT_SECONDS) * 1000;
    if (env?.LOBBY_SECONDS) this.lobbyMs = Number(env.LOBBY_SECONDS) * 1000;
    this.maxRace = Math.min(MAX_RACE_SECONDS, (this.slotMs - this.lobbyMs) / 1000 - 20);
  }

  private slotAt = (ms: number) => Math.floor(ms / this.slotMs);
  private slotStart = (slot: number) => slot * this.slotMs;

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new (globalThis as any).WebSocketPair();
    const client: WebSocket = pair[0];
    const server: WebSocket = pair[1];
    (server as any).accept();
    const conn: Conn = { ws: server, id: null, msgs: 0, windowStart: Date.now() };
    this.conns.add(conn);
    server.addEventListener('message', (e: MessageEvent) => this.onMessage(conn, e.data));
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
  private onMessage(conn: Conn, data: unknown) {
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
        conn.id = String(msg.id ?? '').slice(0, 64) || null;
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
        this.join(conn, msg.name, msg.color);
        break;
      case 'leave':
        if (this.phase === 'lobby' && conn.id) {
          this.players = this.players.filter((p) => p.id !== conn.id);
          this.broadcastRoom();
        }
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

  private join(conn: Conn, rawName: unknown, rawColor: unknown) {
    if (!conn.id) return this.send(conn, { t: 'error', msg: 'Say hello first.' });
    if (this.phase !== 'lobby') return this.send(conn, { t: 'error', msg: 'The race has started. Join the next lobby!' });
    if (this.players.some((p) => p.id === conn.id)) return;
    const name = cleanName(rawName);
    if (!name) return this.send(conn, { t: 'error', msg: 'Pick a nickname (letters and numbers, up to 16).' });
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      return this.send(conn, { t: 'error', msg: 'That nickname is taken in this lobby.' });
    if (this.players.length >= MAX_PLAYERS) {
      // Fair rotation: someone who raced last round gives their seat to a newcomer.
      const bumpable = !this.lastRacers.has(conn.id) && [...this.players].reverse().find((p) => this.lastRacers.has(p.id));
      if (!bumpable) return this.send(conn, { t: 'error', msg: 'The grid is full. Catch the next race!' });
      this.players = this.players.filter((p) => p !== bumpable);
      const bumped = [...this.conns].find((c) => c.id === bumpable.id);
      if (bumped) this.send(bumped, { t: 'error', msg: 'Grid full: you raced last round, so a new player took your seat.' });
    }
    const taken = new Set(this.players.map((p) => p.color));
    let color = PLAYER_COLORS.includes(String(rawColor)) ? String(rawColor) : PLAYER_COLORS[0];
    if (taken.has(color)) color = PLAYER_COLORS.find((c) => !taken.has(c)) ?? color;
    this.players.push({ id: conn.id, name, color, kind: 'human', connected: true });
    this.broadcastRoom();
  }

  private markConnected(id: string | null) {
    if (!id) return;
    const online = [...this.conns].some((c) => c.id === id);
    for (const list of [this.players, this.raceEntries]) {
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
    if (this.conns.size === 0) {
      // Nobody watching: stop spending CPU. The next visitor restarts the loop.
      clearInterval(this.timer!);
      this.timer = null;
      this.sim = null;
      this.slot = -1;
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
      if (this.sim.done) this.finishRace();
    }
  }

  /** Move to the right phase for the current time (new slot -> lobby, lights out -> race). */
  private syncPhase(now: number) {
    const slot = this.slotAt(now);
    if (slot !== this.slot) this.openLobby(slot);
    if (this.phase === 'lobby' && now >= this.startAt) this.startRace();
  }

  private openLobby(slot: number) {
    this.slot = slot;
    this.phase = 'lobby';
    this.lastRacers = new Set(this.raceEntries.filter((e) => e.kind === 'human').map((e) => e.id));
    this.players = [];
    this.raceEntries = [];
    this.sim = null;
    this.snapState = null;
    this.lastResults = null;
    this.carOf.clear();
    const rand = crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
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
    this.raceEntries = entries;
    this.carOf = new Map(humans.map((h, i) => [h.id, i]));
    const simEntries: Entry[] = entries.map((e) => ({
      name: e.name,
      model: e.kind === 'bot' ? HOUSE_BOTS[Number(e.id.slice(4))].name : `player:${e.name}`,
      color: e.color,
      code: '',
      source: e.kind === 'human' ? 'human' : 'bot',
      botParams: e.kind === 'bot' ? { ...HOUSE_BOTS[Number(e.id.slice(4))].params, grip: HOUSE_BOTS[Number(e.id.slice(4))].params.grip * 0.92 } : undefined,
    }));
    this.sim = new RaceSim(null, { seed: this.seed, entries: simEntries, laps: this.laps, maxTime: this.maxRace, obstacles: true });
    this.sentEvents = 0;
    this.phase = 'race';
    this.broadcastRoom();
  }

  private finishRace() {
    if (!this.sim || this.phase !== 'race') return;
    this.phase = 'results';
    const results = this.sim.results();
    const win = results[0];
    const e = this.raceEntries[win.car];
    if (e) {
      this.recent.unshift({
        slot: this.slot,
        name: e.name,
        color: e.color,
        kind: e.kind,
        time: win.finishTime,
        field: this.raceEntries.length,
        humans: this.raceEntries.filter((x) => x.kind === 'human').length,
        at: Date.now(),
      });
      this.recent = this.recent.slice(0, 5);
      void this.storage?.put('recent', this.recent);
    }
    this.lastResults = { results, duration: this.sim.t };
    this.broadcast({ t: 'results', results, duration: this.sim.t });
    this.broadcastRoom();
    // TODO(persist): store { seed, laps, entries, inputLog: this.sim.inputLog, results } in Supabase for replays.
  }

  // ------------------------------------------------------------------ outgoing
  private roomInfo(): RoomInfo {
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
