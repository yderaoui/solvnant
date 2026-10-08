// Test drive: drive a real race on your own, before signing in or buying anything. Everything runs in
// the browser with the same physics, obstacles and bots as live races (RaceSim + house bots), drawn in
// the shared 3D view with the live driver HUD. Nothing is sent to the server or saved.
import { generateTrack, lapsFor, type Track } from '../sim/track';
import { FLAG, RaceSim, type RaceEvent } from '../sim/race';
import { PHYS, type Input } from '../sim/physics';
import { generateObstacles } from '../sim/obstacles';
import { liveSimEntries } from '../game/liveEntries';
import { PLAYER_COLORS, type LobbyEntry } from '../game/protocol';
import type { CarVisual } from './renderer';
import { audio, get3d, load3d } from './view3d';
import { drawMinimap, fmt } from './livegame';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { driveSkin, setTrySkin } from './garage';
import { SKINS, botSkin, skinById } from '../game/skins';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BOTS = 5;
const COUNTDOWN = 3; // s

export class PracticeDrive {
  active = false;
  private sim: RaceSim | null = null;
  private track: Track | null = null;
  private entries: LobbyEntry[] = [];
  private visuals: CarVisual[] = [];
  private keys = new Set<string>();
  private acc = 0;
  private startAt = 0; // performance.now() of lights out
  private lastWall = 0;
  private lastHud = 0;
  private shownEvents = 0;
  private lapStart = 0;
  private bestLap: number | null = null;
  private lastLap = 0;
  private raf = 0;
  private seed = '';
  private finished = false;
  private picking = false; // the racer picker is open: the race is paused
  private pausedAt = 0;

  constructor() {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    $('drv-racer').onclick = () => this.active && this.pickRacer();
    for (const b of document.querySelectorAll<HTMLElement>('[data-touch]')) {
      const k = b.dataset.touch!;
      b.addEventListener('pointerdown', () => this.active && this.keys.add(k));
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => this.keys.delete(k));
    }
  }

  async start(seed?: string) {
    this.active = true;
    this.picking = false;
    $('go-flash').classList.remove('held');
    this.seed = seed ?? `drive-${Math.floor(Math.random() * 1e9).toString(36)}`;
    document.body.classList.add('is-live', 'is-racing', 'view-3d');
    $('cam-chase').classList.add('active');
    this.center(`<div class="card loading" role="status"><div class="spinner"></div><div>Getting your car ready…</div></div>`);
    this.track = generateTrack(this.seed);
    const color = (() => {
      try {
        return localStorage.getItem('agp-color') ?? PLAYER_COLORS[0];
      } catch {
        return PLAYER_COLORS[0];
      }
    })();
    this.entries = [
      { id: 'you', name: 'You', color, kind: 'human', connected: true, skin: driveSkin() },
      ...Array.from({ length: BOTS }, (_, b): LobbyEntry => ({ id: `bot:${b}`, name: `BOT ${'ABCDEFGH'[b]}`, color: PLAYER_COLORS.filter((c) => c !== color)[b], kind: 'bot', connected: true, skin: botSkin(b + 1) })),
    ];
    this.sim = new RaceSim(null, {
      seed: this.seed,
      entries: liveSimEntries(this.entries.map((e) => ({ name: e.name, color: e.color, kind: e.kind, bot: e.kind === 'bot' ? Number(e.id.slice(4)) : null }))),
      laps: lapsFor(this.track),
      maxTime: 230,
      obstacles: true,
    });
    this.acc = 0;
    this.shownEvents = 0;
    this.lapStart = 0;
    this.lastLap = 0;
    this.bestLap = null;
    this.finished = false;
    const c = await load3d($('stage-canvas'));
    if (!this.active) return;
    c.setTrack(this.track);
    c.setObstacles(generateObstacles(this.track));
    c.setCars(this.entries.map((e) => ({ name: e.name, color: e.color, skin: e.skin })), 0);
    c.setCamMode('chase');
    c.warmUp();
    audio.start();
    this.center('');
    this.startAt = performance.now() + COUNTDOWN * 1000;
    this.lastWall = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.frame());
  }

  stop() {
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.keys.clear();
    document.body.classList.remove('is-live', 'is-racing', 'view-3d');
    get3d()?.setVisible(false);
    audio.update(0, 0, 0, 0, 1);
    this.center('');
    $('go-flash').classList.remove('show', 'held');
    this.picking = false;
    this.sim?.dispose();
    this.sim = null;
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (!this.active) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const map: Record<string, string> = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
    const k = map[e.code];
    if (k) {
      e.preventDefault();
      if (down) this.keys.add(k);
      else this.keys.delete(k);
    } else if (down && e.code === 'KeyR' && this.finished) void this.start(this.seed);
    else if (down && e.code === 'KeyP' && !e.repeat) this.picking ? this.resume() : this.pickRacer();
    else if (down && e.code === 'Escape' && this.picking) this.resume();
  }

  private input(): Input {
    if (performance.now() < this.startAt || this.finished) return { throttle: 0, steer: 0, brake: 0 };
    return { throttle: this.keys.has('up') ? 1 : 0, steer: (this.keys.has('right') ? 1 : 0) - (this.keys.has('left') ? 1 : 0), brake: this.keys.has('down') ? 1 : 0 };
  }

  private frame() {
    if (!this.active || !this.sim || !this.track) return;
    this.raf = requestAnimationFrame(() => this.frame());
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastWall) / 1000);
    this.lastWall = now;
    if (this.picking) {
      this.startAt += now - (this.pausedAt || now); // hold the countdown too
      this.pausedAt = now;
      return;
    }
    this.pausedAt = 0;
    const sim = this.sim;
    const input = this.input();
    // The race clock starts at lights out; before that the grid just sits there.
    if (now >= this.startAt && !sim.done) {
      sim.setHumanInput(0, input);
      this.acc += dt;
      let n = 0;
      while (this.acc >= PHYS.dt && n++ < 8 && !sim.done) {
        sim.stepTick();
        this.acc -= PHYS.dt;
      }
    }
    const cars = sim.carStates();
    const v = this.visuals;
    v.length = cars.length;
    cars.forEach((c, i) => {
      v[i] = {
        x: c.x,
        y: c.y,
        h: c.h,
        speed: Math.hypot(c.vx, c.vy),
        slip: c.slip,
        flags: (c.offTrack ? FLAG.offTrack : 0) | (c.stopped ? FLAG.stopped : 0) | (c.finished ? FLAG.finished : 0) | (c.slipstream ? FLAG.slipstream : 0) | (c.brake > 0.1 || (i === 0 && input.brake) ? FLAG.braking : 0),
      };
    });
    // race events: crashes, trees, crowd
    const c3 = get3d();
    for (const ev of sim.events.slice(this.shownEvents)) this.react(ev);
    this.shownEvents = sim.events.length;
    if (c3) {
      c3.setVisible(true);
      c3.render(v, 0, dt);
    }
    const me = v[0];
    audio.update(me.speed, input.throttle, me.slip, c3 ? c3.crowdNear(v, 0) : 0, dt);
    // countdown / GO
    const left = this.startAt - now;
    $('go-flash').textContent = left > 0 ? String(Math.ceil(left / 1000)) : 'GO!';
    $('go-flash').classList.toggle('show', left > -900);
    if (now - this.lastHud > 100) {
      this.lastHud = now;
      this.hud();
    }
    if ((cars[0].finished || sim.done) && !this.finished) {
      this.finished = true;
      setTimeout(() => this.active && this.results(), 1200);
    }
  }

  private react(ev: RaceEvent) {
    get3d()?.onEvent(ev, this.visuals);
    const mine = ev.car === 0 || ev.other === 0;
    const s = Math.min(1, (ev.v ?? 10) / 20);
    if (mine && (ev.type === 'tree' || ev.type === 'fence' || ev.type === 'wall' || ev.type === 'contact')) audio.impact(ev.type === 'tree' ? s : 0.5 + s / 2, ev.type !== 'tree');
    if (ev.type === 'fence') audio.cheer(0.9);
    else if (ev.type === 'overtake' && mine) audio.cheer(0.35);
    else if (ev.type === 'finish') audio.cheer(1);
    if (ev.type !== 'start' && ev.type !== 'wall' && mine) {
      const el = $('ticker');
      el.className = `ticker live-ui show ev-${ev.type}`;
      el.textContent = ev.text.replace(/^🏁\s*/u, '');
      setTimeout(() => el.classList.remove('show'), 3000);
    }
  }

  private hud() {
    const sim = this.sim!;
    const L = this.track!.length;
    const laps = sim.meta.laps;
    const cars = sim.carStates();
    const order = sim.standingsNow();
    const me = cars[0];
    const rt = Math.max(0, sim.t);
    const lap = Math.min(laps, Math.max(1, Math.floor(me.progress / L) + 1));
    if (me.lapsDone > this.lastLap) {
      const lt = rt - this.lapStart;
      if (lt > 5) this.bestLap = Math.min(this.bestLap ?? Infinity, lt);
      this.lastLap = me.lapsDone;
      this.lapStart = rt;
    }
    const pos = order.indexOf(0) + 1;
    $('drv-pos').textContent = `P${pos}`;
    $('drv-of').textContent = `/ ${order.length}`;
    $('drv-lap').textContent = String(lap);
    $('drv-laps').textContent = String(laps);
    const rows = order
      .slice(Math.max(0, Math.min(order.length - 5, pos - 3)), Math.max(0, Math.min(order.length - 5, pos - 3)) + 5)
      .map((i) => {
        const p = order.indexOf(i) + 1;
        const gap = i === 0 ? '---' : cars[i].finished ? 'FIN' : `${(((cars[0].progress - cars[i].progress) / Math.max(15, Math.hypot(cars[i].vx, cars[i].vy))) > 0 ? '+' : '-')}${Math.abs((cars[0].progress - cars[i].progress) / Math.max(15, Math.hypot(cars[i].vx, cars[i].vy))).toFixed(1)}s`;
        return `<li class="${i === 0 ? 'me' : ''}"><span class="p">${p}</span><span class="n">${i === 0 ? 'You' : escapeHtml(this.entries[i].name)}</span><span class="g">${gap}</span></li>`;
      })
      .join('');
    if ($('drv-rows').innerHTML !== rows) $('drv-rows').innerHTML = rows;
    $('t-cur').textContent = me.finished ? 'FINISHED' : fmt(Math.max(0, rt - this.lapStart), 2);
    $('t-best').textContent = this.bestLap ? fmt(this.bestLap, 2) : '–';
    $('t-total').textContent = fmt(rt, 2);
    const v = this.visuals[0];
    const kmh = Math.round(v.speed * 3.6);
    const fwd = me.vx * Math.cos(me.h) + me.vy * Math.sin(me.h);
    $('speedo-kmh').textContent = String(kmh);
    $('speedo-arc').style.strokeDasharray = `${(75 * Math.min(1, kmh / 240)).toFixed(1)} 100`;
    $('speedo-arc').style.opacity = kmh > 0 ? '1' : '0';
    const gears = [0, 45, 80, 115, 150, 185, 215];
    $('speedo-gear').textContent = fwd < -0.5 ? 'R' : kmh < 2 ? 'N' : String(gears.filter((g) => kmh >= g).length);
    drawMinimap($<HTMLCanvasElement>('minimap'), this.track!, this.visuals, this.entries, 0);
    $('mini-pos').textContent = `P${pos}`;
  }

  private results() {
    const res = this.sim!.results();
    const mine = res.find((r) => r.car === 0)!;
    const win = res[0];
    const rows = res
      .map((r) => {
        const e = this.entries[r.car];
        const time = r.finished ? (r.position === 1 ? fmt(r.finishTime!, 2) : `+${(r.finishTime! - win.finishTime!).toFixed(2)}s`) : r.crashed ? 'DNF' : `${Math.max(0, Math.round(r.progress))} m`;
        return `<tr class="${r.car === 0 ? 'me' : ''}"><td class="pos">${r.position}</td><td><span class="who"><span class="av" style="--c:${e.color}">${r.car === 0 ? 'Y' : icon('bot', 14)}</span>${r.car === 0 ? 'You' : escapeHtml(e.name)}</span></td><td class="num">${time}</td><td class="num">${r.bestLap ? fmt(r.bestLap, 2) : '–'}</td></tr>`;
      })
      .join('');
    this.center(`
      <div class="card results" role="dialog" aria-label="Test drive results">
        <div class="res-kicker">TEST DRIVE · NOTHING SAVED</div>
        <div class="res-head">${icon('trophy', 26)}${mine.position === 1 ? 'YOU WIN!' : `YOU FINISHED P${mine.position}`}</div>
        <table><thead><tr><th>P</th><th>Driver</th><th>Time</th><th>Best lap</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="res-foot">
          <button class="btn" id="pd-again">${icon('replay', 14)}Same track (R)</button>
          <button class="btn" id="pd-new">${icon('shuffle', 14)}New track</button>
          <a class="btn btn-lime" href="#/live">${icon('flag', 14)}PLAY FOR REAL</a>
        </div>
        <div class="res-kicker pd-try">TRY ANOTHER RACER</div>
        ${this.racerRow()}
      </div>`);
    this.bindRacers();
    $('pd-again').onclick = () => void this.start(this.seed);
    $('pd-new').onclick = () => void this.start();
  }

  private racerRow(): string {
    const cur = driveSkin();
    return `<div class="pd-racers">${SKINS.map(
      (s) =>
        `<button class="pd-racer${s.id === cur ? ' on' : ''}" data-racer="${s.id}" aria-pressed="${s.id === cur}" title="${escapeHtml(s.name)}${s.price ? '' : ' (free)'}"><img src="${import.meta.env.BASE_URL}assets/characters/${s.file}.webp" alt="" loading="lazy" /><span>${escapeHtml(s.name)}</span></button>`,
    ).join('')}</div>`;
  }

  private bindRacers() {
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-racer]'))
      b.onclick = () => {
        setTrySkin(b.dataset.racer!);
        void this.start(this.seed); // same track, new racer
      };
  }

  /** The Racer button: pause the drive behind a picker of every racer. */
  private pickRacer() {
    if (this.finished || this.picking) return;
    this.keys.clear();
    this.picking = true;
    $('go-flash').classList.add('held');
    this.center(`
      <div class="card results" role="dialog" aria-label="Pick a racer">
        <div class="res-kicker">TEST DRIVE · ANY RACER, FREE</div>
        <div class="res-head">${icon('car', 26)}PICK YOUR RACER</div>
        <p class="muted small">Now: <b>${escapeHtml(skinById(driveSkin()).name)}</b>. Picking one restarts this track with it.</p>
        ${this.racerRow()}
        <div class="res-foot"><button class="btn" id="pd-close">${icon('x', 14)}Keep driving</button></div>
      </div>`);
    this.bindRacers();
    $('pd-close').onclick = () => this.resume();
  }

  private resume() {
    this.picking = false;
    $('go-flash').classList.remove('held');
    this.center('');
  }

  private center(html: string) {
    const el = $('center');
    if (el.innerHTML !== html) el.innerHTML = html;
    el.classList.toggle('show', html !== '');
    document.body.classList.toggle('has-overlay', html !== '');
  }
}
