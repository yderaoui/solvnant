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
import { driveSkin, mySkin, setTrySkin } from './garage';
import { account } from './account';
import { soloConfig } from '../game/lobbies';
import type { Car } from '../sim/physics';
import type { InputLogEntry } from '../sim/race';
import { SKINS, botSkin, skinById } from '../game/skins';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BOTS = 5;
const COUNTDOWN = 3; // s

/** A seat in a ticketed ghost lobby, as /api/lobby/join hands it out. */
export interface TicketRun {
  run: string;
  lobby: string;
  seed: string;
  seats: number;
  pot: number;
  prize: number;
  ghosts: { name: string; color: string; skin: string; log: InputLogEntry[]; finishTime: number | null }[];
}

interface SeatView {
  name: string;
  color: string;
  you: boolean;
  racing: boolean;
  finished: boolean;
  finishTime: number | null;
  progress: number;
  note: string | null;
}
interface LobbyView {
  lobby: { status: string; settleBy: number; seats: number; maxSeats: number; pot: number; prize: number; youWon: boolean };
  seats: SeatView[];
  rejected?: string | null;
}

/** Same order as the sim's standings: finished by time, then furthest along. */
function orderCars(cars: Car[]): number[] {
  return cars
    .map((_, i) => i)
    .sort((a, b) => {
      const A = cars[a],
        B = cars[b];
      if (A.finished && B.finished) return A.finishTime! - B.finishTime! || a - b;
      if (A.finished) return -1;
      if (B.finished) return 1;
      return B.progress - A.progress || a - b;
    });
}

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
  /** Ticketed race: your run is a solo sim; each ghost is its own sim replaying a recorded run. */
  ticket: TicketRun | null = null;
  private ghostSims: RaceSim[] = [];
  private submitted = false;
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

  async start(seed?: string, seat?: TicketRun | (() => Promise<TicketRun>)) {
    this.active = true;
    this.picking = false;
    let ticket = typeof seat === 'function' ? undefined : seat;
    if (typeof seat === 'function') {
      // Ticketed race: load the 3D view first, then take the seat. The server's clock starts at the seat,
      // so the countdown has to follow right away.
      document.body.classList.add('is-live', 'is-racing', 'view-3d');
      this.center(`<div class="card loading" role="status"><div class="spinner"></div><div>Finding you a lobby…</div></div>`);
      await load3d($('stage-canvas'));
      if (!this.active) return;
      try {
        ticket = await seat();
      } catch (e) {
        if (this.active)
          this.center(`<div class="card results" role="alert"><div class="res-head">${icon('alert', 26)}No race this time</div><p class="muted">${escapeHtml((e as Error).message)}</p><div class="res-foot"><a class="btn btn-lime" href="#/race">Back to races</a></div></div>`);
        return;
      }
      if (!this.active) return; // left while joining: the seat counts as a DNF at its deadline
    }
    this.ticket = ticket ?? null;
    this.submitted = false;
    if (ticket) seed = ticket.seed;
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
    if (ticket) {
      // No bots in ticketed races: you against the recorded runs of the players already in this lobby.
      this.entries = [
        { id: 'you', name: 'You', color, kind: 'human', connected: true, skin: mySkin() },
        ...ticket.ghosts.map((g, i): LobbyEntry => ({ id: `ghost:${i}`, name: g.name, color: g.color, kind: 'human', connected: true, skin: g.skin })),
      ];
      this.sim = new RaceSim(null, soloConfig(this.seed));
      this.ghostSims = ticket.ghosts.map((g) => new RaceSim(null, soloConfig(this.seed, g.log)));
    } else {
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
      this.ghostSims = [];
    }
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
    c.setCars(this.entries.map((e) => ({ name: e.name, color: e.color, skin: e.skin, ghost: e.id.startsWith('ghost:') })), 0);
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
    // Leaving a ticketed race mid-way: hand in what was driven (it counts as not finished).
    if (this.ticket && !this.submitted && this.sim && performance.now() >= this.startAt) void this.submit();
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
    for (const g of this.ghostSims) g.dispose();
    this.ghostSims = [];
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
    } else if (down && e.code === 'KeyR' && this.finished && !this.ticket) void this.start(this.seed);
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
        for (const g of this.ghostSims) if (!g.done) g.stepTick(); // ghosts keep the same clock
        this.acc -= PHYS.dt;
      }
    }
    const cars = this.cars();
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

  /** Every car on screen: yours (and the bots) from the main sim, then one per ghost. */
  private cars(): Car[] {
    return [...this.sim!.carStates(), ...this.ghostSims.map((g) => g.carStates()[0])];
  }

  private hud() {
    const sim = this.sim!;
    const L = this.track!.length;
    const laps = sim.meta.laps;
    const cars = this.cars();
    const order = this.ghostSims.length ? orderCars(cars) : sim.standingsNow();
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
    if (this.ticket) return void this.submit();
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
          <a class="btn btn-lime" href="#/race">${icon('flag', 14)}PLAY FOR REAL</a>
        </div>
        <div class="res-kicker pd-try">TRY ANOTHER RACER</div>
        ${this.racerRow()}
      </div>`);
    this.bindRacers();
    $('pd-again').onclick = () => void this.start(this.seed);
    $('pd-new').onclick = () => void this.start();
  }

  /** Ticketed race over (or left): send the inputs; the server re-runs them and ranks the lobby. */
  private async submit() {
    const t = this.ticket;
    if (!t || this.submitted || !this.sim) return;
    this.submitted = true;
    const log = this.sim.inputLog.map((e) => [...e]);
    if (this.active) this.center(`<div class="card loading" role="status"><div class="spinner"></div><div>Checking your run…</div></div>`);
    let view: LobbyView;
    try {
      view = await account.api<LobbyView>('/api/lobby/submit', { run: t.run, log });
    } catch (e) {
      if (this.active) this.center(`<div class="card results"><div class="res-head">${icon('alert', 26)}Couldn't send your run</div><p class="muted">${escapeHtml((e as Error).message)}</p><div class="res-foot"><a class="btn btn-lime" href="#/race">Back to races</a></div></div>`);
      return;
    }
    if (!this.active) return;
    const L = view.lobby;
    const mine = view.seats.findIndex((s) => s.you);
    const me = view.seats[mine];
    const fin = view.seats.filter((s) => s.finished);
    const best = fin[0]?.finishTime ?? null;
    const rows = view.seats
      .map((s, i) => {
        const time = s.racing ? 'racing…' : s.finished ? (i === 0 ? fmt(s.finishTime!, 2) : best !== null ? `+${(s.finishTime! - best).toFixed(2)}s` : fmt(s.finishTime!, 2)) : s.progress > 0 && !s.note ? `${s.progress} m` : 'DNF';
        return `<tr class="${s.you ? 'me' : ''}"><td class="pos">${i + 1}</td><td><span class="who"><span class="av" style="--c:${s.color}">${s.you ? 'Y' : icon('users', 14)}</span>${s.you ? 'You' : escapeHtml(s.name)}</span></td><td class="num">${time}</td></tr>`;
      })
      .join('');
    const sym = account.cfg?.tickets?.symbol ?? '$TRACK';
    const head =
      L.status === 'settled'
        ? L.youWon
          ? `${icon('trophy', 26)}YOU WON ${L.prize.toLocaleString('en-US')} ${escapeHtml(sym)}`
          : `${icon('flag', 26)}LOBBY SETTLED: P${mine + 1}`
        : me?.finished
          ? `${icon('flag', 26)}${fmt(me.finishTime!, 2)} · P${mine + 1} OF ${L.seats} SO FAR`
          : `${icon('flag', 26)}DID NOT FINISH`;
    const status =
      L.status === 'settled'
        ? `Settled: ${L.seats} players, ${L.prize.toLocaleString('en-US')} ${escapeHtml(sym)} to the winner.`
        : L.status === 'refunded'
          ? 'Not enough players: everyone got their ticket back.'
          : `${L.seats}/${L.maxSeats} seats taken. Pot ${L.pot.toLocaleString('en-US')} ${escapeHtml(sym)} so far. Settles when full, or at ${new Date(L.settleBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} with 4+ players (3 or fewer: tickets refunded).`;
    this.center(`
      <div class="card results" role="dialog" aria-label="Your run">
        <div class="res-kicker">TICKETED RACE · WINNER TAKES ALL</div>
        <div class="res-head">${head}</div>
        ${view.rejected ? `<p class="acct-warn">${icon('alert', 14)}Your run was not accepted (${escapeHtml(view.rejected)}).</p>` : ''}
        <table><thead><tr><th>P</th><th>Driver</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="muted small">${status}</p>
        <div class="res-foot">
          <a class="btn btn-lime" href="#/race">${icon('flag', 14)}RACE AGAIN</a>
        </div>
      </div>`);
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
    if (this.finished || this.picking || this.ticket) return;
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
