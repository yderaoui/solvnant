// Live multiplayer: join the lobby, drive (3D chase view by default, 2D map optional), or spectate.
// The server is authoritative. Your own car is predicted locally so it responds instantly, then
// gently corrected toward the server; other cars are interpolated ~100 ms in the past.
import { generateTrack, type Track } from '../sim/track';
import { FLAG, newCar, type CarResult, type RaceEvent } from '../sim/race';
import { PHYS, locate, stepCar, type Car, type Input } from '../sim/physics';
import { CAR_SNAP_STRIDE, PLAYER_COLORS, type LobbyEntry, type RoomInfo, type ServerMsg } from '../game/protocol';
import { GameConnection } from './net';
import { collideObstacles, generateObstacles, type Obstacles } from '../sim/obstacles';
import type { CarVisual, RaceRenderer } from './renderer';
import { audio, get3d, load3d } from './view3d';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { account, fmtPts, showAuthModal } from './account';
import { BetWidget } from './bets';
import { toast } from './toast';
import { buyTicket, claimPendingTicket, getTestCoins } from './tickets';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Snap {
  recv: number; // local performance.now()
  rt: number; // server race time, s
  c: number[];
  order: number[];
}

type View = '3d' | 'fan' | 'follow' | 'map';

export const fmt = (s: number, dp = 1) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(dp).padStart(dp + 3, '0')}`;
};
const fmtCountdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const ago = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};
const initials = (name: string) =>
  name
    .replace(/^BOT\s+/i, '')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';
const avatar = (e: { name: string; color: string; kind?: string }) =>
  `<span class="av" style="--c:${e.color}">${e.kind === 'bot' ? icon('bot', 14) : escapeHtml(initials(e.name))}</span>`;
const carIcon = (color: string) =>
  `<svg class="car-ic" viewBox="0 0 48 16" aria-hidden="true"><path d="M2 11 6 6l10-2h12l8 3 8 1 2 3v2H2z" fill="${color}"/><path d="M17 5h9l5 3H14z" fill="#0b1220" opacity=".8"/><circle cx="11" cy="13" r="3" fill="#0b0d10" stroke="#9aa3ad"/><circle cx="37" cy="13" r="3" fill="#0b0d10" stroke="#9aa3ad"/></svg>`;

export class LiveGame {
  active = false;
  private conn = new GameConnection();
  private room: RoomInfo | null = null;
  private you: string | null = null; // our id in the room (account uid when signed in)
  private bets = new BetWidget($('bet-bar'), 'BET ON THE WINNER', toast);
  private priority = false;
  private backSelf = 0; // points to bet on yourself at lights out (0 = off)
  private car: number | null = null;
  private track: Track | null = null;
  private trackSeed = '';
  private carsSeed = '';
  private snaps: Snap[] = [];
  private snapGap = 0.06; // s of race time between snapshots (smoothed); sets the interpolation delay
  private events: RaceEvent[] = [];
  private results: CarResult[] | null = null;
  private pred: Car | null = null;
  private tmp: Car | null = null;
  private acc = 0;
  private keys = new Set<string>();
  private input: Input = { throttle: 0, steer: 0, brake: 0 };
  private lastSent = 0;
  private sentKey = '';
  private view: View = '3d';
  private spectate = -1;
  private lastWall = performance.now();
  private lastHud = 0;
  private overlayFor = 'stale';
  private visuals: CarVisual[] = [];
  private goUntil = 0;
  // lap timing per car, from snapshots
  private lapNo: number[] = [];
  private lapStart: number[] = [];
  private bestLap: (number | null)[] = [];
  private tickerUntil = 0;
  private shownEvents = 0;
  // 3D view (lazy-loaded, shared with the AI League)
  private get c3d() {
    return this.active ? get3d() : null;
  }
  // obstacles: `ob` follows the server (events), `predOb` is what our own prediction collides with
  private ob: Obstacles | null = null;
  private predOb: Obstacles | null = null;
  private audio = audio;

  constructor(private renderer: RaceRenderer) {
    this.conn.onMessage = (m) => this.onMessage(m);
    this.conn.onStatus = (ok) => {
      if (!ok && this.active) this.ticker('Reconnecting to the race server…', 4000);
    };
    renderer.app.ticker.add(() => this.frame());
    // Signing in/out mid-session: re-introduce ourselves to the room and redraw the lobby.
    account.onChange(() => {
      if (this.conn.token !== account.token) {
        this.conn.token = account.token;
        this.conn.hello();
      }
      if (this.active && this.room?.phase === 'lobby') this.overlayFor = 'stale';
      this.paintJoinNext();
    });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    for (const b of document.querySelectorAll<HTMLElement>('[data-touch]')) {
      const k = b.dataset.touch!;
      const on = (e: Event) => {
        e.preventDefault();
        this.keys.add(k);
      };
      const off = (e: Event) => {
        e.preventDefault();
        this.keys.delete(k);
      };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointerleave', off);
      b.addEventListener('pointercancel', off);
    }
    const pick = (e: Event) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-car]');
      if (li) this.spectateCar(Number(li.dataset.car));
    };
    for (const id of ['spec-drivers', 'spec-rows']) {
      $(id).addEventListener('click', pick);
      $(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick(e);
        }
      });
    }
    $('spectate-btn').onclick = () => {
      this.audio.start();
      this.setView(this.view === 'map' ? '3d' : 'map');
    };
    $('mute-btn').addEventListener('click', () => {
      if (this.active) this.toggleMute();
    });
    $('join-next').onclick = () => this.toggleNext();
    try {
      this.backSelf = Math.max(0, Math.floor(Number(localStorage.getItem('tl-back') ?? 0)) || 0);
    } catch {
      /* ignore */
    }
    this.paintMute();
    // Browsers only allow sound after a gesture: start it on the first click/key while live.
    const unlock = () => {
      if (this.active) this.audio.start();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private toggleMute() {
    this.audio.start();
    this.audio.setMuted(!this.audio.muted);
    this.paintMute();
  }

  private paintMute() {
    const b = $('mute-btn');
    b.innerHTML = icon(this.audio.muted ? 'mute' : 'sound');
    b.setAttribute('aria-pressed', String(this.audio.muted));
    b.setAttribute('aria-label', this.audio.muted ? 'Unmute sound (M)' : 'Mute sound (M)');
  }

  start() {
    this.active = true;
    document.body.classList.add('is-live');
    this.bindCamButtons();
    this.renderer.onCarClick = (i) => this.spectateCar(i);
    void claimPendingTicket().then((ok) => ok && toast('Your earlier ticket payment is now credited'));
    this.conn.token = account.token;
    this.conn.connect(); // fresh socket: the server answers with the current lobby/race straight away
    if (this.room) this.applyRoom(this.room, true);
    // Warm up the 3D view (three.js, car model, textures) while people sit in the lobby.
    setTimeout(() => {
      if (this.active) void this.ensure3d();
    }, 1500);
  }

  stop() {
    this.active = false;
    document.body.classList.remove('is-live', 'is-racing', 'in-lobby', 'is-spec', 'view-3d', 'view-fan', 'has-market', 'has-overlay');
    setCenter('');
    $('load3d').hidden = true;
    get3d()?.setVisible(false);
    this.renderer.app.stage.visible = true;
    this.audio.update(0, 0, 0, 0, 1);
    this.pushed3d = '';
    this.conn.close();
    this.room = null;
    this.trackSeed = this.carsSeed = '';
    this.overlayFor = 'stale';
  }

  // ------------------------------------------------------------------ network
  private onMessage(m: ServerMsg) {
    switch (m.t) {
      case 'room':
        this.car = m.car;
        this.you = m.you;
        this.applyRoom(m.room, false);
        break;
      case 'snap':
        const prevRt = this.snaps.at(-1)?.rt;
        if (prevRt !== undefined && m.rt > prevRt && m.rt - prevRt < 0.5) this.snapGap += (m.rt - prevRt - this.snapGap) * 0.1;
        this.snaps.push({ recv: performance.now(), rt: m.rt, c: m.c, order: m.order });
        if (this.snaps.length > 40) this.snaps.shift();
        if (m.ev && m.catchup) {
          // joined mid-race: just put fallen trees down, no crash effects
          for (const ev of m.ev) if (ev.obj !== undefined) this.treeFell(ev.obj, false);
        } else if (m.ev) {
          this.events.push(...m.ev);
          for (const ev of m.ev) this.react(ev);
        }
        this.trackLaps(m.c, m.rt);
        if (this.car !== null) this.reconcile(m.c);
        break;
      case 'results':
        this.results = m.results;
        break;
      case 'points':
        account.setPoints(m.points);
        break;
      case 'error':
        this.ticker(m.msg, 4000);
        if (this.room?.phase === 'lobby') {
          const err = document.getElementById('lb-err');
          if (err) err.textContent = m.msg;
        }
        break;
    }
  }

  private applyRoom(room: RoomInfo, force: boolean) {
    const prevPhase = this.room?.phase;
    this.room = room;
    if (!this.active) return;
    if (room.seed !== this.trackSeed) {
      this.trackSeed = room.seed;
      this.track = generateTrack(room.seed);
      this.renderer.setTrack(this.track);
      this.renderer.setCars([]);
      this.c3d?.setTrack(this.track);
      this.c3d?.setCars([], -1);
      this.ob = generateObstacles(this.track);
      this.predOb = { ...this.ob, down: [...this.ob.down] };
      this.renderer.setObstacles(this.ob);
      this.c3d?.setObstacles(this.ob);
      this.carsSeed = '';
      this.snaps = [];
      this.events = [];
      this.shownEvents = 0;
      this.results = null;
      this.pred = null;
      this.spectate = -1;
      this.lapNo = [];
      this.lapStart = [];
      this.bestLap = [];
      this.renderer.selected = -1;
      this.setView(this.view === 'fan' ? '3d' : this.view); // keep the viewer's camera (3D unless they picked the map)
      this.renderer.resetCamera();
    }
    if (room.phase !== 'lobby' && this.carsSeed !== room.seed + room.phase) {
      this.carsSeed = room.seed + room.phase;
      this.renderer.you = this.car ?? -1;
      const cars = room.entries.map((e) => ({ name: e.name, color: e.color }));
      this.renderer.setCars(cars);
      this.c3d?.setCars(cars, this.car ?? -1);
    }
    if (room.phase === 'race' && prevPhase === 'lobby' && this.car !== null && this.backSelf > 0) void this.placeBackSelf(room.slot);
    if (room.phase === 'race' && prevPhase === 'lobby') {
      this.goUntil = performance.now() + 1200;
      if (this.car !== null) this.setView('3d');
      else this.spectate = 0;
    }
    if (force || prevPhase !== room.phase) this.overlayFor = 'stale';
    this.bets.open = room.betsOpen;
    this.bets.setMarket(room.market);
    document.body.classList.toggle('has-market', !!room.market); // bots-only races have no betting
    if (prevPhase === 'race' && room.phase === 'results') void account.refresh(); // prizes, bet payouts
    const driving = room.phase !== 'lobby' && this.car !== null;
    document.body.classList.toggle('in-lobby', room.phase === 'lobby');
    document.body.classList.toggle('is-racing', driving);
    document.body.classList.toggle('is-spec', room.phase !== 'lobby' && !driving);
    $('rs-phase').textContent = room.phase === 'lobby' ? 'LOBBY' : room.phase === 'race' ? 'LIVE RACE' : 'FINISHED';
    this.paintJoinNext();
  }

  private get signedUpNext() {
    return !!this.you && !!this.room?.next?.some((e) => e.id === this.you);
  }

  /** "Join next race" (any time outside the lobby): the server seats you when the next lobby opens. */
  private toggleNext() {
    if (!account.me) return showAuthModal();
    if (!account.me.canRace) return this.ticker(account.me.raceBlock ?? 'You can’t race yet.', 4000);
    if (this.room?.phase === 'lobby') return;
    if (this.signedUpNext) this.conn.send({ t: 'leave' });
    else this.join();
  }

  private paintJoinNext() {
    const on = this.signedUpNext;
    const n = this.room?.next?.length ?? 0;
    const label = !account.me ? 'SIGN IN TO RACE NEXT' : on ? '✓ SIGNED UP FOR NEXT RACE · LEAVE' : `JOIN NEXT RACE${n ? ` · ${n} signed up` : ''}`;
    for (const el of [document.getElementById('join-next'), document.getElementById('res-join')]) {
      if (!el) continue;
      el.textContent = label;
      el.classList.toggle('on', on);
    }
  }

  /** Lights out: place the "back yourself" bet chosen in the lobby (the market opens a moment later). */
  private async placeBackSelf(slot: number) {
    const amount = this.backSelf;
    for (let tries = 0; tries < 6; tries++) {
      await new Promise((r) => setTimeout(r, 700));
      const room = this.room;
      if (!room || room.slot !== slot || room.phase !== 'race' || this.car === null) return;
      if (!room.market) continue;
      try {
        const r = await account.api<{ points: number }>('/api/bet', { market: room.market, pick: String(this.car), amount });
        account.setPoints(r.points);
        this.ticker(`You backed yourself: ${fmtPts(amount)} pts`, 3000);
        return;
      } catch (e) {
        const msg = (e as Error).message;
        if (/No such market/.test(msg)) continue;
        this.ticker(`Back-yourself bet failed: ${msg}`, 4000);
        return;
      }
    }
  }

  private join() {
    const me = account.me;
    if (!me) return showAuthModal();
    // (auto-join runs before the lobby card is drawn: fall back to the saved colour)
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('agp-color');
    } catch {
      /* ignore */
    }
    const color = document.querySelector<HTMLInputElement>('input[name="lb-color"]:checked')?.value ?? saved ?? PLAYER_COLORS[0];
    const err = document.getElementById('lb-err');
    if (err) err.textContent = '';
    try {
      localStorage.setItem('agp-color', color);
    } catch {
      /* ignore */
    }
    this.conn.send({ t: 'join', color, priority: this.priority });
  }

  // ------------------------------------------------------------------ input
  private onKey(e: KeyboardEvent, down: boolean) {
    if (!this.active) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const map: Record<string, string> = {
      ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
      ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    };
    const k = map[e.code];
    if (k) {
      if (this.room?.phase === 'race' && this.car !== null) e.preventDefault();
      if (down) this.keys.add(k);
      else this.keys.delete(k);
      return;
    }
    if (!down) return;
    if (e.code === 'KeyC') this.cycleView();
    if (e.code === 'KeyM') this.toggleMute();
    if (e.code === 'KeyV' && this.view === 'fan') this.c3d?.nextFanSpot();
    if (e.code === 'BracketRight' || e.code === 'BracketLeft') this.cycleSpectate(e.code === 'BracketRight' ? 1 : -1);
  }

  private readInput(): Input {
    const steer = (this.keys.has('right') ? 1 : 0) - (this.keys.has('left') ? 1 : 0);
    return { throttle: this.keys.has('up') ? 1 : 0, steer, brake: this.keys.has('down') ? 1 : 0 };
  }

  private sendInput(now: number) {
    const i = this.input;
    const key = `${i.throttle}|${i.steer}|${i.brake}`;
    // Only on change (+1 s keepalive): the socket is reliable and the server keeps the last input.
    if (key !== this.sentKey || now - this.lastSent > 1000) {
      this.conn.send({ t: 'in', th: i.throttle, st: i.steer, br: i.brake });
      this.sentKey = key;
      this.lastSent = now;
    }
  }

  // ------------------------------------------------------------------ prediction
  private carFrom(c: number[], i: number, into: Car | null): Car {
    const o = i * CAR_SNAP_STRIDE;
    const car = into ?? newCar(i, c[o], c[o + 1], c[o + 2], nearestIndex(this.track!, c[o], c[o + 1]), 0, c[o + 7], 0, 7);
    car.reverse = true;
    car.x = c[o];
    car.y = c[o + 1];
    car.h = c[o + 2];
    car.vx = c[o + 3];
    car.vy = c[o + 4];
    car.steer = c[o + 5];
    car.slip = c[o + 6];
    car.progress = c[o + 7];
    const f = c[o + 8];
    car.stopped = (f & FLAG.stopped) !== 0;
    car.finished = (f & FLAG.finished) !== 0;
    locate(car, this.track!);
    return car;
  }

  private reconcile(c: number[]) {
    if (!this.track || this.car === null) return;
    const me = this.car;
    if (!this.pred) {
      this.pred = this.carFrom(c, me, null);
      return;
    }
    // Where the server car will be by the time our current input reaches it.
    this.tmp = this.carFrom(c, me, this.tmp);
    const ahead = Math.max(0, Math.min(30, Math.round(this.conn.rtt / 1000 / PHYS.dt)));
    for (let k = 0; k < ahead; k++) {
      stepCar(this.tmp, this.input, PHYS.dt);
      if (this.predOb) collideObstacles(this.tmp, { ...this.predOb, down: [...this.predOb.down] });
      locate(this.tmp, this.track);
    }
    const p = this.pred,
      t = this.tmp;
    const err = Math.hypot(t.x - p.x, t.y - p.y);
    if (err > 8) {
      Object.assign(p, t);
    } else {
      const a = 0.2;
      p.x += (t.x - p.x) * a;
      p.y += (t.y - p.y) * a;
      p.vx += (t.vx - p.vx) * 0.3;
      p.vy += (t.vy - p.vy) * 0.3;
      let dh = t.h - p.h;
      dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI;
      p.h += dh * a;
      p.progress = t.progress;
    }
    p.stopped = t.stopped;
    p.finished = t.finished;
  }

  private treeFell(i: number, animate: boolean) {
    if (this.ob) this.ob.down[i] = true;
    if (this.predOb) this.predOb.down[i] = true;
    this.renderer.treeDown(i);
    if (!animate && this.ob) this.c3d?.syncDown(this.ob.down);
  }

  /** A race event from the server: crash effects, crowd reactions, sounds. */
  private react(ev: RaceEvent) {
    if (ev.type === 'tree' && ev.down && ev.obj !== undefined) this.treeFell(ev.obj, true);
    this.c3d?.onEvent(ev, this.visuals);
    const order = this.snaps.at(-1)?.order ?? [];
    const focus = this.focusCar(order);
    const mine = ev.car === focus || ev.other === focus;
    const s = Math.min(1, (ev.v ?? 10) / 20);
    if (mine && (ev.type === 'tree' || ev.type === 'fence' || ev.type === 'wall' || ev.type === 'contact')) this.audio.impact(ev.type === 'tree' ? s : 0.5 + s / 2, ev.type !== 'tree');
    if (ev.type === 'fence') this.audio.cheer(0.9);
    else if (ev.type === 'tree' && ev.down) this.audio.cheer(0.6);
    else if (ev.type === 'overtake') this.audio.cheer(0.35);
    else if (ev.type === 'finish') this.audio.cheer(1);
  }

  private trackLaps(c: number[], rt: number) {
    if (!this.track || !this.room) return;
    const L = this.track.length;
    const n = c.length / CAR_SNAP_STRIDE;
    for (let i = 0; i < n; i++) {
      const lap = Math.max(0, Math.floor(c[i * CAR_SNAP_STRIDE + 7] / L));
      if (this.lapNo[i] === undefined) {
        this.lapNo[i] = lap;
        this.lapStart[i] = 0;
        this.bestLap[i] = null;
      } else if (lap > this.lapNo[i]) {
        const t = rt - this.lapStart[i];
        if (t > 5) this.bestLap[i] = Math.min(this.bestLap[i] ?? Infinity, t);
        this.lapNo[i] = lap;
        this.lapStart[i] = rt;
      }
    }
  }

  // ------------------------------------------------------------------ frame
  private frame() {
    if (!this.active) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastWall) / 1000);
    this.lastWall = now;
    const room = this.room;
    if (!room || !this.track) {
      this.renderer.render([], [], dt, false);
      return;
    }

    const racing = room.phase === 'race' && this.car !== null;
    this.input = racing && !this.pred?.finished ? this.readInput() : { throttle: 0, steer: 0, brake: 0 };
    if (racing) this.sendInput(now);

    // Own car: advance the prediction in fixed steps.
    if (racing && this.pred) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= PHYS.dt && n++ < 10) {
        stepCar(this.pred, this.input, PHYS.dt);
        if (this.predOb) collideObstacles(this.pred, this.predOb);
        locate(this.pred, this.track);
        this.acc -= PHYS.dt;
      }
    }

    const { cars, order } = this.sampleCars(now);
    // In the lobby (no cars yet) the 3D view flies over the circuit behind the join card.
    const use3d = (this.view === '3d' || this.view === 'fan') && !!this.c3d && this.pushed3d !== '';
    this.c3d?.setVisible(use3d);
    $('load3d').hidden = !((this.view === '3d' || this.view === 'fan') && !use3d);
    this.renderer.app.stage.visible = !use3d;
    if (use3d) this.c3d!.render(cars, this.focusCar(order), dt);
    else this.renderer.render(cars, order, dt, room.phase === 'race');

    // Sound follows the car we're watching
    const fc = cars[this.focusCar(order)];
    if (fc && room.phase !== 'lobby') {
      const mine = this.car !== null && this.focusCar(order) === this.car;
      const throttle = mine ? this.input.throttle : fc.flags & FLAG.braking ? 0 : 0.7;
      const fan = use3d && this.view === 'fan';
      const near = fan ? 1 : use3d ? this.c3d!.crowdNear(cars, this.focusCar(order)) : 0.2;
      const engine = fan ? Math.max(0.04, 1 - this.c3d!.distanceTo(fc) / 220) : 1;
      this.audio.update(fc.speed, throttle, fc.slip, near, dt, engine);
    } else this.audio.update(0, 0, 0, 0.1, dt);

    if (now - this.lastHud > 100) {
      this.lastHud = now;
      this.updateHud(cars, order);
    }
  }

  private focusCar(order: number[]): number {
    if (this.car !== null) return this.car;
    if (this.spectate >= 0) return this.spectate;
    return order[0] ?? 0;
  }

  /** Cars ~100 ms in the past (smooth), own car from the prediction. */
  private sampleCars(now: number): { cars: CarVisual[]; order: number[] } {
    const snaps = this.snaps;
    if (!snaps.length || this.room?.phase === 'lobby') return { cars: [], order: [] };
    const last = snaps[snaps.length - 1];
    const serverRt = last.rt + (now - last.recv) / 1000;
    // Draw other cars a little in the past so there is always a newer snapshot to slide towards: about
    // two snapshot gaps (the server sends ~15-20 a second; a fixed 75 ms ran dry and made cars stutter).
    const cushion = Math.min(0.25, Math.max(0.09, this.snapGap * 2));
    const rt = this.room?.phase === 'race' ? serverRt - cushion : last.rt;
    let a = snaps[0],
      b = snaps[0];
    for (let i = 0; i < snaps.length; i++) {
      if (snaps[i].rt <= rt) a = snaps[i];
      if (snaps[i].rt >= rt) {
        b = snaps[i];
        break;
      }
      b = snaps[i];
    }
    const f = b.rt > a.rt ? Math.max(0, Math.min(1, (rt - a.rt) / (b.rt - a.rt))) : 1;
    const n = a.c.length / CAR_SNAP_STRIDE;
    const out = this.visuals;
    out.length = n;
    for (let i = 0; i < n; i++) {
      const o = i * CAR_SNAP_STRIDE;
      let dh = b.c[o + 2] - a.c[o + 2];
      dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI;
      const vx = a.c[o + 3] + (b.c[o + 3] - a.c[o + 3]) * f,
        vy = a.c[o + 4] + (b.c[o + 4] - a.c[o + 4]) * f;
      out[i] = {
        x: a.c[o] + (b.c[o] - a.c[o]) * f,
        y: a.c[o + 1] + (b.c[o + 1] - a.c[o + 1]) * f,
        h: a.c[o + 2] + dh * f,
        speed: Math.hypot(vx, vy),
        slip: b.c[o + 6],
        flags: b.c[o + 8],
      };
    }
    if (this.car !== null && this.pred && this.room?.phase === 'race') {
      const p = this.pred;
      const braking = this.input.brake > 0 ? FLAG.braking : 0;
      out[this.car] = { x: p.x, y: p.y, h: p.h, speed: Math.hypot(p.vx, p.vy), slip: p.slip, flags: ((out[this.car]?.flags ?? 0) & ~FLAG.braking) | braking };
    }
    return { cars: out, order: last.order };
  }

  // ------------------------------------------------------------------ views / cameras
  private bindCamButtons() {
    $('cam-overview').onclick = () => this.setView('map');
    $('cam-leader').onclick = () => this.setView('follow');
    $('cam-chase').onclick = () => this.setView('3d');
    $('cam-fan').onclick = () => {
      if (this.view === 'fan') this.c3d?.nextFanSpot();
      else this.setView('fan');
    };
  }

  private setView(v: View) {
    if (v === 'fan' && this.car !== null && this.room?.phase === 'race') v = '3d'; // drivers drive, fans watch
    this.view = v;
    if (v === '3d' || v === 'fan') {
      this.audio.start();
      void this.ensure3d().then(() => this.c3d?.setCamMode(this.view === 'fan' ? 'fan' : 'chase'));
    }
    this.renderer.focus = this.car ?? Math.max(0, this.spectate);
    this.renderer.mode = v === 'map' ? 'overview' : this.car !== null || this.spectate >= 0 ? 'car' : 'leader';
    const active = v === 'map' ? 'cam-overview' : v === '3d' ? 'cam-chase' : v === 'fan' ? 'cam-fan' : 'cam-leader';
    for (const id of ['cam-overview', 'cam-leader', 'cam-chase', 'cam-fan']) {
      $(id).classList.toggle('active', id === active);
      $(id).setAttribute('aria-pressed', String(id === active));
    }
    document.body.classList.toggle('view-3d', v === '3d' || v === 'fan');
    document.body.classList.toggle('view-fan', v === 'fan');
    $('spectate-btn').setAttribute('aria-pressed', String(v !== 'map'));
    $('spectate-btn').querySelector('span')!.textContent = v === 'map' ? 'WATCH IN 3D' : 'MAP VIEW';
  }

  /** Load the shared 3D view if needed and give it our track, obstacles and cars. */
  private pushed3d = '';
  private async ensure3d(): Promise<void> {
    const c = await load3d($('stage-canvas'));
    if (!this.active) return;
    const key = `${this.trackSeed}|${this.carsSeed}`;
    if (this.pushed3d === key) return;
    this.pushed3d = key;
    if (this.track) c.setTrack(this.track);
    if (this.ob) c.setObstacles(this.ob);
    c.setCars(this.room && this.room.phase !== 'lobby' ? this.room.entries.map((e) => ({ name: e.name, color: e.color })) : [], this.car ?? -1);
    c.warmUp();
  }

  private cycleView() {
    const spectating = this.car === null || this.room?.phase !== 'race';
    const order: View[] = spectating ? ['3d', 'fan', 'follow', 'map'] : ['3d', 'follow', 'map'];
    this.setView(order[(Math.max(0, order.indexOf(this.view)) + 1) % order.length]);
  }

  spectateCar(i: number) {
    if (this.car !== null && this.room?.phase === 'race') return; // drivers watch their own car
    this.spectate = i;
    this.renderer.selected = i;
    this.setView(this.view === 'map' ? 'follow' : this.view);
    this.lastHud = 0;
  }

  private cycleSpectate(dir: number) {
    const order = this.snaps.at(-1)?.order;
    if (!order?.length) return;
    const at = order.indexOf(this.spectate);
    this.spectateCar(order[(at + dir + order.length) % order.length]);
  }

  // ------------------------------------------------------------------ HUD + overlays
  private progressOf(i: number): number {
    const s = this.snaps.at(-1);
    return s ? s.c[i * CAR_SNAP_STRIDE + 7] : 0;
  }

  /** Seconds car b is behind car a (negative = b is ahead), from the distance between them. */
  private gapSeconds(a: number, b: number, cars: CarVisual[]): number {
    const d = this.progressOf(a) - this.progressOf(b);
    const v = Math.max(15, ((cars[a]?.speed ?? 0) + (cars[b]?.speed ?? 0)) / 2);
    return d / v;
  }

  private updateHud(cars: CarVisual[], order: number[]) {
    const room = this.room!;
    const L = this.track!.length;
    const now = this.conn.serverNow();
    const last = this.snaps.at(-1);
    const rt = room.phase === 'race' && last ? last.rt + (performance.now() - last.recv) / 1000 : (last?.rt ?? 0);
    const lapOf = (i: number) => Math.min(room.laps, Math.max(1, Math.floor(this.progressOf(i) / L) + 1));

    // Race strip (top right)
    if (room.phase === 'lobby') {
      $('rs-lap').textContent = `${room.laps} ${room.laps === 1 ? 'LAP' : 'LAPS'}`;
      $('rs-clock').textContent = fmtCountdown(room.startAt - now);
    } else {
      const ref = this.car ?? order[0];
      $('rs-lap').textContent = ref !== undefined ? `LAP ${lapOf(ref)} / ${room.laps}` : '';
      $('rs-clock').textContent = fmt(rt, 2);
    }

    // Overlay: lobby / results / none
    const want = room.phase === 'lobby' ? `lobby${room.slot}` : room.phase === 'results' && this.results ? `res${room.slot}:${room.prizes?.length ?? 0}:${room.replayId ?? ''}` : ''; // redraw once prizes/replay land
    if (want !== this.overlayFor) {
      this.overlayFor = want;
      if (want.startsWith('lobby')) this.renderLobby();
      else if (want.startsWith('res')) this.renderResults();
      else setCenter('');
    }
    if (room.phase === 'lobby') this.patchLobby(now);
    if (room.phase === 'results') {
      const el = document.getElementById('res-next');
      if (el) el.textContent = fmtCountdown(room.slotEnd - now);
    }
    $('go-flash').classList.toggle('show', performance.now() < this.goUntil);

    // Event ticker (latest event, a few seconds)
    if (this.events.length > this.shownEvents) {
      const ev = this.events.slice(this.shownEvents).filter((e) => e.type !== 'start' && e.type !== 'wall').at(-1);
      this.shownEvents = this.events.length;
      if (ev) this.ticker(ev.text.replace(/^🏁\s*/u, ''), 3500, ev.type);
    }
    if (performance.now() > this.tickerUntil) $('ticker').classList.remove('show');

    if (room.phase === 'lobby' || !order.length) return;
    if (this.car !== null && cars[this.car]) this.updateDriverHud(cars, order, rt, lapOf);
    else this.updateSpectatorHud(cars, order);
    const focus = this.focusCar(order);
    drawMinimap($<HTMLCanvasElement>('minimap'), this.track!, cars, room.entries, focus);
    const fpos = order.indexOf(focus) + 1;
    $('mini-pos').textContent = fpos ? `P${fpos}` : '';
  }

  private updateDriverHud(cars: CarVisual[], order: number[], rt: number, lapOf: (i: number) => number) {
    const room = this.room!;
    const me = this.car!;
    const pos = order.indexOf(me) + 1;
    $('drv-pos').textContent = `P${pos}`;
    $('drv-of').textContent = `/ ${order.length}`;
    $('drv-lap').textContent = String(lapOf(me));
    $('drv-laps').textContent = String(room.laps);
    const start = Math.max(0, Math.min(order.length - 5, pos - 3));
    const rows = order
      .slice(start, start + 5)
      .map((i, k) => {
        const p = start + k + 1;
        const e = room.entries[i];
        const isMe = i === me;
        const g = this.gapSeconds(me, i, cars); // > 0: they're behind me
        const fin = ((cars[i]?.flags ?? 0) & FLAG.finished) !== 0;
        const gap = isMe ? '---' : fin ? 'FIN' : `${g > 0 ? '+' : '-'}${Math.abs(g).toFixed(1)}s`;
        return `<li class="${isMe ? 'me' : ''}"><span class="p">${p}</span><span class="n">${isMe ? 'You' : escapeHtml(e?.name ?? '?')}</span><span class="g">${gap}</span></li>`;
      })
      .join('');
    if ($('drv-rows').innerHTML !== rows) $('drv-rows').innerHTML = rows;

    const finished = (cars[me].flags & FLAG.finished) !== 0;
    $('t-cur').textContent = finished ? 'FINISHED' : fmt(Math.max(0, rt - (this.lapStart[me] ?? 0)), 2);
    $('t-best').textContent = this.bestLap[me] ? fmt(this.bestLap[me]!, 2) : '–';
    $('t-total').textContent = fmt(rt, 2);

    // Speedometer
    const p = this.pred;
    const v = cars[me].speed;
    const fwd = p ? p.vx * Math.cos(p.h) + p.vy * Math.sin(p.h) : v;
    const kmh = Math.round(v * 3.6);
    $('speedo-kmh').textContent = String(kmh);
    $('speedo-arc').style.strokeDasharray = `${(75 * Math.min(1, kmh / 240)).toFixed(1)} 100`;
    $('speedo-arc').style.opacity = kmh > 0 ? '1' : '0';
    const gears = [0, 45, 80, 115, 150, 185, 215];
    $('speedo-gear').textContent = fwd < -0.5 ? 'R' : kmh < 2 ? 'N' : String(gears.filter((g) => kmh >= g).length);
  }

  private updateSpectatorHud(cars: CarVisual[], order: number[]) {
    const room = this.room!;
    const focus = this.focusCar(order);
    // Leaderboard
    const lead = order[0];
    const rows = order
      .map((i, p) => {
        const e = room.entries[i];
        if (!e) return '';
        const f = cars[i]?.flags ?? 0;
        const out = f & FLAG.stopped && !(f & FLAG.finished);
        const gap = p === 0 ? 'LEADER' : out ? 'OUT' : f & FLAG.finished ? 'FIN' : `+${this.gapSeconds(lead, i, cars).toFixed(1)}s`;
        return `<li data-car="${i}" class="${i === focus ? 'sel' : ''}" tabindex="0"><span class="pb">${p + 1}</span>${avatar(e)}<span class="n">${escapeHtml(e.name)}</span><span class="g">${gap}</span></li>`;
      })
      .join('');
    if ($('spec-rows').innerHTML !== rows) $('spec-rows').innerHTML = rows;

    // Win probability (live estimate from the gaps and how much race is left)
    const probs = this.winProbabilities(cars, order);
    const top = order.slice(0, 3);
    const others = Math.max(0, 1 - top.reduce((s, i) => s + probs[i], 0));
    const pRow = (label: string, color: string, p: number) =>
      `<li><span class="dot" style="background:${color}"></span><span class="n">${label}</span><span class="pv">${Math.round(p * 100)}%</span><span class="pbar"><i style="width:${(p * 100).toFixed(0)}%;background:${color}"></i></span></li>`;
    const probHtml =
      top.map((i) => pRow(escapeHtml(room.entries[i]?.name ?? '?'), room.entries[i]?.color ?? '#fff', probs[i])).join('') +
      (order.length > 3 ? pRow('Others', '#6b7280', others) : '');
    if ($('spec-prob').innerHTML !== probHtml) $('spec-prob').innerHTML = probHtml;

    // Driver list (pick who to follow)
    const list = room.entries
      .map((e, i) => `<li data-car="${i}" class="${i === focus ? 'sel' : ''}" tabindex="0" role="button" aria-pressed="${i === focus}">${avatar(e)}<span class="who"><b>${escapeHtml(e.name)}</b><small>${e.kind === 'bot' ? 'AI bot' : e.connected ? 'Player' : 'Player · away'}</small></span><span class="radio" aria-hidden="true"></span></li>`)
      .join('');
    if ($('spec-drivers').innerHTML !== list) $('spec-drivers').innerHTML = list;
  }

  private winProbabilities(cars: CarVisual[], order: number[]): number[] {
    const p: number[] = new Array(cars.length).fill(0);
    if (!order.length) return p;
    if ((cars[order[0]]?.flags ?? 0) & FLAG.finished) {
      p[order[0]] = 1;
      return p;
    }
    const L = this.track!.length * this.room!.laps;
    const left = Math.max(0.05, 1 - Math.max(0, this.progressOf(order[0])) / L);
    const temp = 1.5 + 30 * left; // seconds of "anything can happen": shrinks as the race goes on
    let sum = 0;
    for (const i of order) {
      const out = (cars[i]?.flags ?? 0) & FLAG.stopped;
      p[i] = out ? 0 : Math.exp(-this.gapSeconds(order[0], i, cars) / temp);
      sum += p[i];
    }
    for (const i of order) p[i] = sum > 0 ? p[i] / sum : 0;
    return p;
  }

  private ticker(text: string, ms: number, type = '') {
    const el = $('ticker');
    el.className = `ticker live-ui show ev-${type}`;
    el.textContent = text;
    this.tickerUntil = performance.now() + ms;
  }

  private renderLobby() {
    const savedColor = (() => {
      try {
        return localStorage.getItem('agp-color') ?? PLAYER_COLORS[0];
      } catch {
        return PLAYER_COLORS[0];
      }
    })();
    const room = this.room!;
    const me = account.me;
    const cfg = account.cfg;
    const fee = room.entryFee;
    const signin = !me
      ? `<div class="lb-signin">
           <p>${icon('flag', 16)}<span>Sign in to take a seat${cfg?.x ? ' (X account)' : ''}. New accounts get <b>${fmtPts(cfg?.points.signup ?? 1000)} points</b>.</span></p>
           <ul class="lb-boosts">
             <li>${icon('zap', 14)}<b>Priority pass</b> +${fmtPts(room.priorityFee)} pts: skip the queue, guaranteed seat</li>
             <li>${icon('trophy', 14)}<b>Back yourself</b>: bet points on your own win</li>
           </ul>
           <button class="btn btn-lime btn-big" id="lb-signin">SIGN IN TO RACE ${icon('play', 16)}</button>
           <a class="btn btn-ghost lb-testdrive" href="#/drive">${icon('pad', 16)}Test drive first: no sign-in needed</a>
         </div>`
      : !me.canRace
        ? `<p class="lb-block">${icon('alert', 16)}<span>${escapeHtml(me.raceBlock ?? 'You can’t race yet.')}</span></p>`
        : `<div class="lb-me">${icon('check', 14)}<span>Racing as <b>${escapeHtml(me.handle ? '@' + me.handle : me.name)}</b></span><span class="pts">${fmtPts(me.points)} pts</span></div>
           <div class="lb-colors" role="radiogroup" aria-label="Car colour">
             ${PLAYER_COLORS.map((c) => `<label class="swatch-pick" style="--c:${c}"><input type="radio" name="lb-color" value="${c}" ${c === savedColor ? 'checked' : ''} aria-label="Colour ${c}"/><span></span></label>`).join('')}
           </div>
           <label class="lb-prio"><input type="checkbox" id="lb-prio" ${this.priority ? 'checked' : ''}/><span><b>Priority pass: skip the queue</b> +${fmtPts(room.priorityFee)} pts<small id="lb-prio-left">Guaranteed seat, can’t be bumped</small></span></label>
           <label class="lb-back"><span><b>Back yourself</b><small>Bet on your own win at lights out</small></span>
             <select id="lb-back" aria-label="Points to bet on yourself">${[0, 50, 100, 250, 500].map((v) => `<option value="${v}" ${v === this.backSelf ? 'selected' : ''}>${v ? `${v} pts` : 'Off'}</option>`).join('')}</select></label>
           ${
             cfg?.tickets
               ? `<div class="lb-ticket"><span><b>Race ticket</b><small>${cfg.tickets.price} ${escapeHtml(cfg.tickets.symbol)} · you have <b id="lb-tix">${me.tickets ?? 0}</b></small></span>
                    <button class="btn small" id="lb-buy">${icon('zap', 14)}Buy ticket</button></div>
                  ${cfg.tickets.cluster === 'devnet' ? `<button class="btn small btn-ghost lb-faucet" id="lb-faucet">${icon('zap', 14)}Get free test ${escapeHtml(cfg.tickets.symbol)}</button>` : ''}
                  <p class="muted small" id="lb-buystep">${cfg.tickets.cluster === 'devnet' ? 'Test network: tickets use devnet test coins (no real value). Phantom: Settings → Developer settings → Testnet mode → Solana Devnet.' : ''}</p>`
               : ''
           }
           <a class="lb-warmup" href="#/drive">${icon('pad', 14)}Warm up with a test drive</a>
           <p id="lb-err" class="err" role="alert"></p>
           <button class="btn btn-lime btn-big" id="lb-go">JOIN RACE <small id="lb-cost">${cfg?.tickets ? '1 ticket + ' : ''}${fmtPts(fee + (this.priority ? room.priorityFee : 0))} PTS</small></button>`;
    setCenter(`
      <div class="lobby" role="dialog" aria-label="Race lobby">
        <section class="lcard join-card">
          <h2>JOIN THE NEXT RACE</h2>
          <p class="sub">Exclusive. Fast. Competitive.</p>
          <div class="cd-row">
            <div class="lights" aria-hidden="true">${'<span></span>'.repeat(5)}</div>
            <div class="lobby-cd"><span id="lb-label">LIGHTS OUT IN</span><b id="lb-time" role="timer"></b></div>
          </div>
          <dl class="facts">
            <div><dt>${icon('trophy', 16)}Pot size</dt><dd id="lb-pot"></dd></div>
            <div><dt>${icon('zap', 16)}Entry fee</dt><dd class="lime">${fee ? `${fmtPts(fee)} PTS` : 'FREE'}<small>refunded if you leave before lights out</small></dd></div>
            <div><dt>${icon('follow', 16)}Players</dt><dd id="lb-count"></dd></div>
            <div><dt>${icon('clock', 16)}Race duration</dt><dd>${room.laps} ${room.laps === 1 ? 'lap' : 'laps'}<small>≤ ${Math.round((room.slotEnd - room.startAt) / 60000)} min</small></dd></div>
            <div><dt>${icon('history', 16)}Queue position</dt><dd id="lb-qpos"></dd></div>
          </dl>
          <div id="lb-form">${signin}</div>
          <div id="lb-in" hidden>
            <div class="on-grid">${icon('check', 18)}<span><b id="lb-in-title">You're on the grid</b><small id="lb-in-sub">Your grid slot is drawn at lights out.</small></span></div>
            <button class="btn btn-ghost" id="lb-leave">${icon('x')}<span id="lb-leave-text">Leave the grid (refund)</span></button>
          </div>
          <div class="ai-row">${icon('bot', 18)}<span><b>AI opponents</b><small>Empty seats are filled with bots</small></span><span class="toggle on" aria-hidden="true"></span></div>
        </section>
        <section class="lcard queue-card" aria-label="Race queue">
          <h3>RACE QUEUE</h3>
          <p class="sub" id="lb-qcount"></p>
          <ol id="lb-list" class="queue"></ol>
          <div id="lb-wait"></div>
        </section>
        <section class="side-col">
          <div class="lcard prize-card">
            <h3>PRIZE POOL</h3>
            <div class="prize">${icon('trophy', 26)}<b id="lb-prize">${fmtPts(room.pot)}</b><span class="pts">PTS</span></div>
            <p class="sub">Play-money points. Entry fees go into the pot: 60% / 30% / 10% to the top three human drivers.</p>
          </div>
          <div class="lcard">
            <h3>RECENT WINNERS</h3>
            <ol class="winners">${this.winnersHtml()}</ol>
          </div>
          <div class="lcard">
            <h3>RACE RULES</h3>
            <ul class="rules">
              ${cfg?.tickets ? `<li>${icon('zap', 16)}Entry: 1 race ticket (${cfg.tickets.price} ${escapeHtml(cfg.tickets.symbol)}), given back if you leave before lights out</li>` : ''}
              <li>${icon('follow', 16)}Max 10 players per race</li>
              <li>${icon('replay', 16)}Last round's racers give up their seat when the grid is full</li>
              <li>${icon('flag', 16)}One entry per account${cfg?.x ? ' (X login keeps bots out)' : ''}</li>
              <li>${icon('zap', 16)}No X account? Hold $${cfg?.gate?.minUsd ?? 20}+ of $TRACK &nbsp;<a href="#/buy">Buy $TRACK</a></li>
              <li>${icon('trophy', 16)}Priority pass: a guaranteed seat that can't be bumped</li>
            </ul>
          </div>
        </section>
        <div class="lobby-keys"><kbd>↑</kbd><kbd>W</kbd> gas <kbd>↓</kbd><kbd>S</kbd> brake / reverse <kbd>←</kbd><kbd>→</kbd> steer <kbd>C</kbd> camera</div>
      </div>`);
    document.getElementById('lb-signin')?.addEventListener('click', () => showAuthModal());
    document.getElementById('lb-go')?.addEventListener('click', () => {
      this.audio.start();
      this.join();
    });
    document.getElementById('lb-faucet')?.addEventListener('click', async () => {
      const step = $('lb-buystep');
      const btn = $<HTMLButtonElement>('lb-faucet');
      btn.disabled = true;
      try {
        step.textContent = await getTestCoins((t) => (step.textContent = t));
      } catch (e) {
        step.textContent = (e as Error).message;
      } finally {
        btn.disabled = false;
      }
    });
    document.getElementById('lb-buy')?.addEventListener('click', async () => {
      const step = $('lb-buystep');
      const btn = $<HTMLButtonElement>('lb-buy');
      btn.disabled = true;
      try {
        const n = await buyTicket((t) => (step.textContent = t));
        step.textContent = '';
        const tix = document.getElementById('lb-tix');
        if (tix) tix.textContent = String(n);
        toast(`Ticket bought: you have ${n}`);
      } catch (e) {
        step.textContent = (e as Error).message;
      } finally {
        btn.disabled = false;
      }
    });
    const back = document.getElementById('lb-back') as HTMLSelectElement | null;
    if (back)
      back.onchange = () => {
        this.backSelf = Number(back.value) || 0;
        try {
          localStorage.setItem('tl-back', String(this.backSelf));
        } catch {
          /* ignore */
        }
      };
    const prio = document.getElementById('lb-prio') as HTMLInputElement | null;
    if (prio)
      prio.onchange = () => {
        this.priority = prio.checked;
        $('lb-cost').textContent = `${account.cfg?.tickets ? '1 ticket + ' : ''}${fmtPts(room.entryFee + (this.priority ? room.priorityFee : 0))} PTS`;
      };
    $('lb-leave').onclick = () => this.conn.send({ t: 'leave' });
  }

  private winnersHtml(): string {
    const recent = this.room?.recent ?? [];
    if (!recent.length) return '<li class="empty">No finished races yet. Be the first.</li>';
    const now = this.conn.serverNow();
    return recent
      .slice(0, 3)
      .map((w, i) => `<li><span class="p">${i + 1}.</span>${avatar(w)}<span class="n">${escapeHtml(w.name)}</span><span class="t">${w.time ? fmt(w.time, 1) : '—'}</span><span class="a">${ago(now - w.at)}</span></li>`)
      .join('');
  }

  private patchLobby(now: number) {
    const room = this.room!;
    const left = room.startAt - now;
    const t = document.getElementById('lb-time');
    if (!t) return;
    t.textContent = fmtCountdown(left);
    $('lb-label').textContent = left > 5000 ? 'LIGHTS OUT IN' : 'GET READY';
    const lit = left <= 5000 ? Math.max(0, Math.min(5, 5 - Math.floor(left / 1000))) : 0;
    document.querySelectorAll('.lobby .lights span').forEach((el, i) => el.classList.toggle('on', i < lit));
    $('lb-count').textContent = `${room.entries.length} / ${room.maxPlayers}`;
    $('lb-qcount').textContent = `${room.entries.length} ${room.entries.length === 1 ? 'PLAYER' : 'PLAYERS'}${room.waitlist.length ? ` · ${room.waitlist.length} WAITING` : ''}`;
    const pot = `${fmtPts(room.pot)}<small>points · 60/30/10 to the top 3 players</small>`;
    if ($('lb-pot').innerHTML !== pot) $('lb-pot').innerHTML = pot;
    $('lb-prize').textContent = fmtPts(room.pot);
    const pl = document.getElementById('lb-prio-left');
    if (pl) pl.textContent = room.priorityLeft ? `Guaranteed seat, can’t be bumped · ${room.priorityLeft} left` : 'None left this race';
    const myIdx = this.you ? room.entries.findIndex((e) => e.id === this.you) : -1;
    const waitIdx = this.you ? room.waitlist.findIndex((e) => e.id === this.you) : -1;
    const qpos = myIdx >= 0 ? `#${myIdx + 1}<small>Next race</small>` : waitIdx >= 0 ? `W${waitIdx + 1}<small>Waitlist</small>` : '—<small>Not joined</small>';
    if ($('lb-qpos').innerHTML !== qpos) $('lb-qpos').innerHTML = qpos;
    $('lb-form').hidden = myIdx >= 0 || waitIdx >= 0;
    $('lb-in').hidden = myIdx < 0 && waitIdx < 0;
    $('lb-in-title').textContent = myIdx >= 0 ? (room.entries[myIdx].priority ? "You're on the grid (priority)" : "You're on the grid") : `You're #${waitIdx + 1} on the waitlist`;
    $('lb-in-sub').textContent = myIdx >= 0 ? 'Your grid slot is drawn at lights out.' : 'You get the next free seat. Nothing is charged until then.';
    $('lb-leave-text').textContent = myIdx >= 0 ? 'Leave the grid (refund)' : 'Leave the waitlist';
    const rows: string[] = [];
    for (let k = 0; k < room.maxPlayers; k++) {
      const e: LobbyEntry | undefined = room.entries[k];
      if (e) {
        const me = e.id === this.you;
        rows.push(
          `<li class="${me ? 'me' : ''}"><span class="qn">${k + 1}</span>${avatar(e)}<span class="n">${me ? 'You' : escapeHtml(e.name)}${e.priority ? ' <span class="prio" title="Priority pass">P</span>' : ''}</span>${carIcon(e.color)}${me ? '<span class="you">YOU</span>' : `<span class="st ${e.connected ? 'on' : ''}" title="${e.connected ? 'online' : 'away'}"></span>`}</li>`,
        );
      } else {
        const bot = k < 6;
        rows.push(`<li class="open"><span class="qn">${k + 1}</span><span class="av ghost">${bot ? icon('bot', 14) : ''}</span><span class="n">${bot ? 'AI bot fills this seat' : 'Open seat'}</span></li>`);
      }
    }
    const html = rows.join('');
    if ($('lb-list').innerHTML !== html) $('lb-list').innerHTML = html;
    const wait = room.waitlist.length
      ? `<h3 class="wait-h">WAITLIST</h3><ol class="queue wait">${room.waitlist.map((e, k) => `<li class="${e.id === this.you ? 'me' : ''}"><span class="qn">W${k + 1}</span>${avatar(e)}<span class="n">${e.id === this.you ? 'You' : escapeHtml(e.name)}</span></li>`).join('')}</ol>`
      : '';
    if ($('lb-wait').innerHTML !== wait) $('lb-wait').innerHTML = wait;
  }

  private renderResults() {
    const room = this.room!;
    const res = this.results!;
    const win = res[0];
    const rows = res
      .map((r) => {
        const e = room.entries[r.car];
        const time = r.finished ? (r.position === 1 ? fmt(r.finishTime!, 2) : `+${(r.finishTime! - win.finishTime!).toFixed(2)}s`) : r.crashed ? 'DNF' : `${Math.max(0, Math.round(r.progress))} m`;
        const best = this.bestLap[r.car] ?? r.bestLap;
        return `<tr class="${r.car === this.car ? 'me' : ''}"><td class="pos">${r.position}</td><td><span class="who">${e ? avatar(e) : ''}${escapeHtml(e?.name ?? '?')}</span></td><td class="num">${time}</td><td class="num">${best ? fmt(best, 2) : '–'}</td></tr>`;
      })
      .join('');
    const mine = this.car !== null ? res.find((r) => r.car === this.car) : null;
    const head = mine ? (mine.position === 1 ? 'YOU WIN!' : `YOU FINISHED P${mine.position}`) : `${escapeHtml(room.entries[win.car]?.name ?? '')} WINS`;
    setCenter(`
      <div class="card results" role="dialog" aria-label="Race results">
        <div class="res-kicker">RACE #${room.slot % 1000} · FINAL CLASSIFICATION</div>
        <div class="res-head">${icon('trophy', 26)}${head}</div>
        <table><thead><tr><th>P</th><th>Driver</th><th>Time</th><th>Best lap</th></tr></thead><tbody>${rows}</tbody></table>
        ${room.prizes?.length ? `<div class="res-prizes">${icon('trophy', 16)}<span>Prize pot paid: ${room.prizes.map((p) => `<b>${escapeHtml(p.name)}</b> +${fmtPts(p.points)}`).join(' · ')} pts</span></div>` : ''}
        <div class="res-foot"><span>Next lobby opens in <b id="res-next"></b></span><button class="btn btn-lime small" id="res-join"></button>${room.replayId ? `<a class="btn small" href="#/replay/live/${room.replayId}">${icon('replay', 14)}Watch replay</a>` : ''}</div>
      </div>`);
    $('res-join').onclick = () => this.toggleNext();
    this.paintJoinNext();
  }
}

function setCenter(html: string) {
  const el = $('center');
  if (el.innerHTML !== html) el.innerHTML = html;
  el.classList.toggle('show', html !== '');
  document.body.classList.toggle('has-overlay', html !== ''); // phones hide side panels under it
}

function nearestIndex(track: Track, x: number, y: number): number {
  let best = 0,
    bd = Infinity;
  track.points.forEach((p, i) => {
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < bd) (bd = d), (best = i);
  });
  return best;
}

/** Minimap: track outline + car dots in their colours; the followed car is bigger with a white ring. */
export function drawMinimap(cv: HTMLCanvasElement, track: Track, cars: CarVisual[], entries: LobbyEntry[], focus: number) {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const W = cv.width,
    H = cv.height,
    b = track.bounds;
  const s = Math.min((W - 24) / (b.maxX - b.minX), (H - 24) / (b.maxY - b.minY));
  const ox = (W - (b.maxX - b.minX) * s) / 2 - b.minX * s,
    oy = (H - (b.maxY - b.minY) * s) / 2 - b.minY * s;
  ctx.clearRect(0, 0, W, H);
  ctx.lineJoin = 'round';
  const path = () => {
    ctx.beginPath();
    track.points.forEach((p, i) => (i ? ctx.lineTo(p[0] * s + ox, p[1] * s + oy) : ctx.moveTo(p[0] * s + ox, p[1] * s + oy)));
    ctx.closePath();
  };
  path();
  ctx.strokeStyle = 'rgba(140,255,46,0.25)';
  ctx.lineWidth = 9;
  ctx.stroke();
  path();
  ctx.strokeStyle = '#e8edf2';
  ctx.lineWidth = 3.5;
  ctx.stroke();
  const p0 = track.points[0];
  ctx.fillStyle = '#8cff2e';
  ctx.fillRect(p0[0] * s + ox - 2, p0[1] * s + oy - 6, 4, 12);
  cars.forEach((c, i) => {
    if (!c || i === focus) return;
    ctx.fillStyle = entries[i]?.color ?? '#fff';
    ctx.beginPath();
    ctx.arc(c.x * s + ox, c.y * s + oy, 4.5, 0, Math.PI * 2);
    ctx.fill();
  });
  const f = cars[focus];
  if (f) {
    ctx.fillStyle = entries[focus]?.color ?? '#8cff2e';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(f.x * s + ox, f.y * s + oy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
