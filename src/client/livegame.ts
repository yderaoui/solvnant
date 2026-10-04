// Live multiplayer: join the lobby, drive with the keyboard (or touch), watch as a viewer.
// The server is authoritative. Your own car is predicted locally so it responds instantly, then
// gently corrected toward the server; other cars are interpolated ~100 ms in the past.
import { generateTrack, type Track } from '../sim/track';
import { FLAG, newCar, type CarResult, type RaceEvent } from '../sim/race';
import { PHYS, locate, stepCar, type Car, type Input } from '../sim/physics';
import { CAR_SNAP_STRIDE, PLAYER_COLORS, type RoomInfo, type ServerMsg } from '../game/protocol';
import { GameConnection } from './net';
import type { CameraMode, CarVisual, RaceRenderer } from './renderer';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Snap {
  recv: number; // local performance.now()
  rt: number; // server race time, s
  c: number[];
  order: number[];
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const fmtCountdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : String(s);
};

export class LiveGame {
  active = false;
  private conn = new GameConnection();
  private room: RoomInfo | null = null;
  private car: number | null = null;
  private track: Track | null = null;
  private trackSeed = '';
  private carsSeed = '';
  private snaps: Snap[] = [];
  private events: RaceEvent[] = [];
  private results: CarResult[] | null = null;
  private pred: Car | null = null;
  private tmp: Car | null = null;
  private acc = 0;
  private keys = new Set<string>();
  private input: Input = { throttle: 0, steer: 0, brake: 0 };
  private lastSent = 0;
  private sentKey = '';
  private cam: CameraMode = 'leader';
  private spectate = -1;
  private lastWall = performance.now();
  private lastHud = 0;
  private overlayFor = '';
  private visuals: CarVisual[] = [];
  private goUntil = 0;

  constructor(private renderer: RaceRenderer) {
    this.conn.onMessage = (m) => this.onMessage(m);
    this.conn.onStatus = (ok) => {
      $('hud-note').textContent = ok ? '' : 'Reconnecting to the race server…';
    };
    renderer.app.ticker.add(() => this.frame());
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
  }

  start() {
    this.active = true;
    document.body.classList.add('is-live');
    this.bindCamButtons();
    this.renderer.onCarClick = (i) => this.spectateCar(i);
    if (!this.conn.connected) this.conn.connect();
    if (this.room) this.applyRoom(this.room, true);
  }

  stop() {
    this.active = false;
    document.body.classList.remove('is-live', 'is-racing', 'in-lobby');
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
        this.applyRoom(m.room, false);
        break;
      case 'snap':
        this.snaps.push({ recv: performance.now(), rt: m.rt, c: m.c, order: m.order });
        if (this.snaps.length > 40) this.snaps.shift();
        if (m.ev) this.events.push(...m.ev);
        if (this.car !== null) this.reconcile(m.c);
        break;
      case 'results':
        this.results = m.results;
        break;
      case 'error':
        toast(m.msg);
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
      this.carsSeed = '';
      this.snaps = [];
      this.events = [];
      this.results = null;
      this.pred = null;
      this.spectate = -1;
      this.renderer.selected = -1;
      this.setCamera('overview');
      this.renderer.resetCamera();
    }
    if (room.phase !== 'lobby' && this.carsSeed !== room.seed + room.phase) {
      this.carsSeed = room.seed + room.phase;
      this.renderer.you = this.car ?? -1;
      this.renderer.setCars(room.entries.map((e) => ({ name: e.name, color: e.color })));
    }
    if (room.phase === 'race' && prevPhase === 'lobby') {
      this.goUntil = performance.now() + 1200;
      this.setCamera(this.car !== null ? 'chase' : 'leader');
    }
    if (force || prevPhase !== room.phase) this.overlayFor = 'stale';
    document.body.classList.toggle('in-lobby', room.phase === 'lobby');
    document.body.classList.toggle('is-racing', room.phase === 'race' && this.car !== null);
    $('hud-title').textContent = `RACE #${room.slot % 1000}`;
    $('hud-live-text').textContent = room.phase === 'lobby' ? 'LOBBY' : room.phase === 'race' ? 'LIVE' : 'FINISH';
    $('hud-seed').textContent = `${room.viewers} watching · seed ${room.seed}`;
  }

  private join() {
    const name = $<HTMLInputElement>('lb-name').value.trim();
    const color = document.querySelector<HTMLInputElement>('input[name="lb-color"]:checked')?.value ?? PLAYER_COLORS[0];
    try {
      localStorage.setItem('agp-name', name);
      localStorage.setItem('agp-color', color);
    } catch {
      /* ignore */
    }
    this.conn.send({ t: 'join', name, color });
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
    if (e.code === 'KeyC') this.cycleCamera();
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
        locate(this.pred, this.track);
        this.acc -= PHYS.dt;
      }
    }

    const { cars, order } = this.sampleCars(now);
    this.renderer.render(cars, order, dt, room.phase === 'race');

    if (now - this.lastHud > 100) {
      this.lastHud = now;
      this.updateHud(cars, order);
    }
  }

  /** Cars ~100 ms in the past (smooth), own car from the prediction. */
  private sampleCars(now: number): { cars: CarVisual[]; order: number[] } {
    const snaps = this.snaps;
    if (!snaps.length || this.room?.phase === 'lobby') return { cars: [], order: [] };
    const last = snaps[snaps.length - 1];
    const serverRt = last.rt + (now - last.recv) / 1000;
    const rt = this.room?.phase === 'race' ? serverRt - 0.1 : last.rt;
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
      out[this.car] = { x: p.x, y: p.y, h: p.h, speed: Math.hypot(p.vx, p.vy), slip: p.slip, flags: out[this.car]?.flags ?? 0 };
    }
    return { cars: out, order: last.order };
  }

  // ------------------------------------------------------------------ cameras
  private bindCamButtons() {
    $('cam-overview').onclick = () => this.setCamera('overview');
    $('cam-leader').onclick = () => this.setCamera(this.car !== null || this.spectate >= 0 ? 'car' : 'leader');
    $('cam-chase').onclick = () => this.setCamera('chase');
  }

  private setCamera(mode: CameraMode) {
    if (mode === 'chase' && this.car === null && this.spectate < 0) this.spectate = this.snaps.at(-1)?.order[0] ?? 0;
    this.cam = mode;
    this.renderer.mode = mode;
    this.renderer.focus = this.car ?? Math.max(0, this.spectate);
    const active = mode === 'overview' ? 'cam-overview' : mode === 'chase' ? 'cam-chase' : 'cam-leader';
    for (const id of ['cam-overview', 'cam-leader', 'cam-chase']) {
      $(id).classList.toggle('active', id === active);
      $(id).setAttribute('aria-pressed', String(id === active));
    }
  }

  private cycleCamera() {
    const order: CameraMode[] = ['chase', 'car', 'overview'];
    const cur = this.cam === 'leader' ? 'car' : this.cam;
    this.setCamera(order[(order.indexOf(cur) + 1) % order.length]);
  }

  spectateCar(i: number) {
    if (this.car !== null && this.room?.phase === 'race') return; // drivers watch their own car
    this.spectate = i;
    this.renderer.selected = i;
    this.setCamera(this.cam === 'overview' || this.cam === 'leader' ? 'car' : this.cam);
  }

  private cycleSpectate(dir: number) {
    const order = this.snaps.at(-1)?.order;
    if (!order?.length) return;
    const at = order.indexOf(this.spectate);
    this.spectateCar(order[(at + dir + order.length) % order.length]);
  }

  // ------------------------------------------------------------------ HUD + overlays
  private updateHud(cars: CarVisual[], order: number[]) {
    const room = this.room!;
    const L = this.track!.length;
    const now = this.conn.serverNow();
    const last = this.snaps.at(-1);
    const rt = room.phase === 'race' && last ? last.rt + (performance.now() - last.recv) / 1000 : (last?.rt ?? 0);

    // Header line
    if (room.phase === 'lobby') {
      $('hud-lap').innerHTML = `<b>${room.laps}</b> ${room.laps === 1 ? 'LAP' : 'LAPS'}`;
      $('hud-clock').textContent = fmtCountdown(room.startAt - now);
    } else {
      const leadProg = order.length ? (cars[order[0]] ? this.progressOf(order[0]) : 0) : 0;
      $('hud-lap').innerHTML = `LAP <b>${Math.min(room.laps, Math.max(1, Math.floor(leadProg / L) + 1))}</b>/${room.laps}`;
      $('hud-clock').textContent = fmt(rt);
    }

    // Overlay: lobby / results / none
    const want = room.phase === 'lobby' ? `lobby${room.slot}` : room.phase === 'results' && this.results ? `res${room.slot}` : '';
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

    // Tower + feed
    if (room.phase !== 'lobby' && order.length) this.updateTower(cars, order);
    else $('tower').innerHTML = '';
    const feed = this.events.filter((e) => e.type !== 'start').slice(-5).reverse();
    const feedHtml = feed.map((e) => `<li class="ev-${e.type}"><span class="ev-t">${fmt(e.t)}</span><span>${escapeHtml(e.text.replace(/^🏁\s*/u, ''))}</span></li>`).join('');
    if ($('feed').innerHTML !== feedHtml) $('feed').innerHTML = feedHtml;

    // Player HUD
    if (this.car !== null && room.phase !== 'lobby' && cars[this.car]) {
      const me = cars[this.car];
      const pos = order.indexOf(this.car) + 1;
      $('ph-pos').innerHTML = `P${pos}<small>/${order.length}</small>`;
      $('ph-speed').textContent = String(Math.round(me.speed * 3.6));
      const prog = this.pred?.progress ?? this.progressOf(this.car);
      $('ph-lap').textContent = `${Math.min(room.laps, Math.max(1, Math.floor(prog / L) + 1))}/${room.laps}`;
      const ahead = pos > 1 ? order[pos - 2] : -1;
      $('ph-gap').textContent = ahead >= 0 ? `+${((this.progressOf(ahead) - prog) / Math.max(me.speed, 15)).toFixed(1)}s` : 'LEADER';
    }
    drawMinimap($<HTMLCanvasElement>('minimap'), this.track!, cars, this.car ?? this.spectate);
  }

  private progressOf(i: number): number {
    const s = this.snaps.at(-1);
    return s ? s.c[i * CAR_SNAP_STRIDE + 7] : 0;
  }

  private updateTower(cars: CarVisual[], order: number[]) {
    const room = this.room!;
    const tower = $('tower');
    while (tower.children.length > order.length) tower.lastElementChild!.remove();
    while (tower.children.length < order.length) tower.appendChild(document.createElement('li'));
    const lead = this.progressOf(order[0]);
    order.forEach((i, p) => {
      const e = room.entries[i];
      if (!e) return;
      const out = (cars[i]?.flags ?? 0) & FLAG.stopped && !((cars[i]?.flags ?? 0) & FLAG.finished);
      const gap = p === 0 ? 'LEADER' : `+${((lead - this.progressOf(i)) / Math.max(cars[i]?.speed ?? 20, 15)).toFixed(1)}`;
      const li = tower.children[p] as HTMLElement;
      li.dataset.car = String(i);
      li.className = `${i === this.car ? 'me' : ''} ${i === this.spectate ? 'sel' : ''} ${out ? 'is-out' : ''}`;
      const tag = e.kind === 'human' && !e.connected ? '<span class="tag">AFK</span>' : '';
      const html = `<span class="pos">${p + 1}</span><span class="bar" style="background:${e.color}"></span><span class="nm">${escapeHtml(e.name)}${tag}</span><span class="delta same">–</span><span class="gap">${out ? '<span class="out">OUT</span>' : gap}</span>`;
      if (li.innerHTML !== html) li.innerHTML = html;
    });
  }

  private renderLobby() {
    const savedName = (() => {
      try {
        return localStorage.getItem('agp-name') ?? '';
      } catch {
        return '';
      }
    })();
    const savedColor = (() => {
      try {
        return localStorage.getItem('agp-color') ?? PLAYER_COLORS[0];
      } catch {
        return PLAYER_COLORS[0];
      }
    })();
    setCenter(`
      <div class="card lobby" role="dialog" aria-label="Race lobby">
        <div class="lobby-top">
          <div>
            <div class="lobby-kicker">NEXT RACE · ${this.room!.laps} ${this.room!.laps === 1 ? 'LAP' : 'LAPS'}</div>
            <div class="lights" aria-hidden="true">${'<span></span>'.repeat(5)}</div>
            <div class="cd-label" id="lb-label">LIGHTS OUT IN</div>
            <div class="cd-time" id="lb-time" role="timer"></div>
          </div>
        </div>
        <div class="lobby-cols">
          <section class="lobby-grid" aria-label="Grid">
            <h3>GRID <span id="lb-count"></span></h3>
            <ol id="lb-list"></ol>
            <p class="muted small">Empty seats race as bots.</p>
          </section>
          <section class="lobby-join" id="lb-join">
            <div id="lb-form">
              <h3>JOIN THE RACE</h3>
              <label for="lb-name">Nickname</label>
              <input id="lb-name" maxlength="16" autocomplete="nickname" spellcheck="false" placeholder="speedy" value="${escapeHtml(savedName)}" />
              <div class="lb-colors" role="radiogroup" aria-label="Car colour">
                ${PLAYER_COLORS.map((c) => `<label class="swatch-pick" style="--c:${c}"><input type="radio" name="lb-color" value="${c}" ${c === savedColor ? 'checked' : ''} aria-label="Colour ${c}"/><span></span></label>`).join('')}
              </div>
              <button class="btn btn-primary btn-big" id="lb-go">${icon('flag')}JOIN GRID</button>
            </div>
            <div id="lb-in" hidden>
              <h3>YOU'RE ON THE GRID</h3>
              <p class="muted">Get ready. Your grid spot is drawn at lights out.</p>
              <button class="btn btn-ghost" id="lb-leave">${icon('x')}Leave</button>
            </div>
          </section>
        </div>
        <div class="lobby-keys"><kbd>↑</kbd><kbd>W</kbd> GAS <kbd>↓</kbd><kbd>S</kbd> BRAKE / REVERSE <kbd>←</kbd><kbd>→</kbd> STEER <kbd>C</kbd> CAMERA</div>
      </div>`);
    $('lb-go').onclick = () => this.join();
    $('lb-name').onkeydown = (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.join();
    };
    $('lb-leave').onclick = () => this.conn.send({ t: 'leave' });
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
    $('lb-count').textContent = `${room.entries.length}/${room.maxPlayers}`;
    const me = room.entries.find((e) => e.id === this.conn.id);
    $('lb-form').hidden = !!me;
    $('lb-in').hidden = !me;
    const html =
      room.entries
        .map((e) => `<li class="${e.id === this.conn.id ? 'me' : ''}"><span class="bar" style="background:${e.color}"></span>${escapeHtml(e.name)}${e.id === this.conn.id ? ' <span class="tag">YOU</span>' : ''}</li>`)
        .join('') + (room.entries.length < 6 ? `<li class="empty-slot">+ ${6 - room.entries.length} bot${6 - room.entries.length === 1 ? '' : 's'}</li>` : '');
    if ($('lb-list').innerHTML !== html) $('lb-list').innerHTML = html;
  }

  private renderResults() {
    const room = this.room!;
    const res = this.results!;
    const rows = res
      .map((r) => {
        const e = room.entries[r.car];
        const win = res[0];
        const time = r.finished ? (r.position === 1 ? fmt(r.finishTime!) : `+${(r.finishTime! - win.finishTime!).toFixed(2)}s`) : r.crashed ? 'DNF' : `${Math.max(0, Math.round(r.progress))} m`;
        return `<tr class="${r.car === this.car ? 'me' : ''}"><td class="pos">${r.position}</td><td><span class="bar" style="background:${e?.color}"></span>${escapeHtml(e?.name ?? '?')}</td><td class="num">${time}</td><td class="num">${r.bestLap ? r.bestLap.toFixed(2) : '–'}</td></tr>`;
      })
      .join('');
    const mine = this.car !== null ? res.find((r) => r.car === this.car) : null;
    const head = mine ? (mine.position === 1 ? 'YOU WIN!' : `YOU FINISHED P${mine.position}`) : `${escapeHtml(room.entries[res[0].car]?.name ?? '')} WINS`;
    setCenter(`
      <div class="card results" role="dialog" aria-label="Race results">
        <div class="res-kicker">RACE #${room.slot % 1000} · FINAL</div>
        <div class="res-head">${icon('trophy', 26)}${head}</div>
        <table><thead><tr><th>P</th><th>Driver</th><th>Time</th><th>Best lap</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="res-foot"><span>Next lobby opens in <b id="res-next"></b></span></div>
      </div>`);
  }
}

function setCenter(html: string) {
  const el = $('center');
  if (el.innerHTML !== html) el.innerHTML = html;
  el.classList.toggle('show', html !== '');
}

function toast(text: string) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
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

/** Tiny pixel minimap: track outline + car dots, drawn at low resolution and upscaled. */
function drawMinimap(cv: HTMLCanvasElement, track: Track, cars: CarVisual[], focus: number) {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const W = cv.width,
    H = cv.height,
    b = track.bounds;
  const s = Math.min((W - 8) / (b.maxX - b.minX), (H - 8) / (b.maxY - b.minY));
  const ox = (W - (b.maxX - b.minX) * s) / 2 - b.minX * s,
    oy = (H - (b.maxY - b.minY) * s) / 2 - b.minY * s;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = '#fff1e8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  track.points.forEach((p, i) => (i ? ctx.lineTo(Math.round(p[0] * s + ox), Math.round(p[1] * s + oy)) : ctx.moveTo(Math.round(p[0] * s + ox), Math.round(p[1] * s + oy))));
  ctx.closePath();
  ctx.stroke();
  const p0 = track.points[0];
  ctx.fillStyle = '#ff004d';
  ctx.fillRect(Math.round(p0[0] * s + ox) - 1, Math.round(p0[1] * s + oy) - 3, 3, 6);
  cars.forEach((c, i) => {
    if (!c) return;
    const x = Math.round(c.x * s + ox),
      y = Math.round(c.y * s + oy);
    const big = i === focus;
    ctx.fillStyle = big ? '#ffec27' : '#29adff';
    ctx.fillRect(x - (big ? 2 : 1), y - (big ? 2 : 1), big ? 5 : 3, big ? 5 : 3);
  });
}
