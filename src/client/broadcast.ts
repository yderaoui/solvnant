// Plays a simulated race as a broadcast: countdown, live timing tower, lap counter,
// event feed and a results card. Live mode is locked to the wall clock (everyone watching
// sees the same moment); replay mode has play/pause/seek/speed.
import { generateTrack, type Track } from '../sim/track';
import { FLAG, OBSTACLES_SINCE, type RaceEvent } from '../sim/race';
import { generateObstacles, type Obstacles } from '../sim/obstacles';
import { audio, get3d, load3d } from './view3d';
import { MAX_RACE_SECONDS } from '../sim/schedule';
import { RaceRenderer, type CameraMode, type CarVisual } from './renderer';
import { simulate, type LiveRecord } from './simClient';
import { escapeHtml } from './codeViewer';
import { icon, type IconName } from './icons';
import type { RaceInfo, StoredResult } from './data';

export type PlayMode = 'live' | 'replay';

const EVENT_ICON: Record<string, IconName> = {
  overtake: 'overtake',
  crash: 'alert',
  dnf: 'alert',
  contact: 'zap',
  wall: 'alert',
  tree: 'alert',
  fence: 'zap',
  fastest_lap: 'clock',
  final_lap: 'flag',
  finish: 'flag',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Broadcast {
  race: RaceInfo | null = null;
  record: LiveRecord | null = null;
  track: Track | null = null;
  mode: PlayMode = 'live';
  private loadToken = 0;
  // replay clock
  private replayBase = 0; // performance.now() at replay time 0 (adjusted on seek/pause/speed)
  private replaySpeed = 1;
  private paused = false;
  private pausedAt = 0;
  private lastWall = performance.now();
  private lastHud = 0;
  private lastEventCount = -1;
  private pendingVerify: StoredResult[] | null = null;
  private verified: 'yes' | 'no' | 'pending' | 'none' = 'none';
  private resultsShown = false;
  onSelectCar: (car: number) => void = () => {};
  onPostRace: () => void = () => {};

  /** False while another controller (the live multiplayer game) owns the stage. */
  active = true;
  /** 3D camera for this broadcast: off, chase behind the followed car, or first person from the crowd. */
  private view3d: 'none' | '3d' | 'fan' = 'none';
  private ob: Obstacles | null = null;
  private pushed3d = '';
  private lastEvT = -1;

  constructor(public renderer: RaceRenderer) {
    this.bind();
    $('replay-play').onclick = () => this.togglePause();
    $<HTMLInputElement>('replay-seek').oninput = (e) => this.seek(Number((e.target as HTMLInputElement).value));
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      b.onclick = () => this.setSpeed(Number(b.dataset.speed));
    }
    renderer.app.ticker.add(() => this.update());
  }

  /** Take over the shared stage: camera buttons and car clicks. */
  bind() {
    this.active = true;
    this.renderer.onCarClick = (i) => this.onSelectCar(i);
    $('cam-overview').onclick = () => this.setCamera('overview');
    $('cam-leader').onclick = () => this.setCamera('leader');
    $('cam-chase').onclick = () => this.setCamera3d('3d');
    $('cam-fan').onclick = () => {
      if (this.view3d === 'fan') get3d()?.nextFanSpot();
      else this.setCamera3d('fan');
    };
    this.pushed3d = '';
  }

  get in3d() {
    return this.view3d !== 'none';
  }

  /** Switch to a 3D camera (loads three.js on first use). */
  setCamera3d(mode: '3d' | 'fan') {
    this.view3d = mode;
    audio.start();
    this.paintCams();
    void load3d($('stage-canvas')).then((c) => {
      this.push3d();
      c.setCamMode(mode === 'fan' ? 'fan' : 'chase');
    });
  }

  /** Give the shared 3D view this race's track, obstacles and cars (once per race). */
  private push3d() {
    const c = get3d();
    if (!c || !this.active || !this.track) return;
    const key = `${this.track.seed}|${this.race?.id ?? ''}|${this.race?.entries.length ?? 0}|${this.ob ? 1 : 0}`;
    if (key === this.pushed3d) return;
    this.pushed3d = key;
    c.setTrack(this.track);
    c.setObstacles(this.ob ? { ...this.ob, down: this.ob.trees.map(() => false) } : null);
    c.setCars((this.race?.entries ?? []).map((e) => ({ name: e.name, color: e.color })), -1);
    c.warmUp();
    this.lastEvT = -1;
  }

  private paintCams() {
    const active = this.view3d === '3d' ? 'cam-chase' : this.view3d === 'fan' ? 'cam-fan' : `cam-${this.renderer.mode}`;
    for (const id of ['cam-overview', 'cam-leader', 'cam-chase', 'cam-fan']) {
      const on = id === active;
      $(id).classList.toggle('active', on);
      $(id).setAttribute('aria-pressed', String(on));
    }
  }

  /** Feed race events to the 3D view as playback passes them; after a seek, jump the tree state. */
  private play3dEvents(c: NonNullable<ReturnType<typeof get3d>>, t: number, cars: CarVisual[]) {
    const evs = this.record?.events ?? [];
    if (t < this.lastEvT || t - this.lastEvT > 1.5) {
      if (this.ob) c.syncDown(this.ob.trees.map((_, i) => evs.some((e) => e.type === 'tree' && e.down && e.obj === i && e.t <= t)));
    } else {
      for (const e of evs) if (e.t > this.lastEvT && e.t <= t) this.react3d(c, e, cars);
    }
    this.lastEvT = t;
  }

  private react3d(c: NonNullable<ReturnType<typeof get3d>>, e: RaceEvent, cars: CarVisual[]) {
    c.onEvent(e, cars);
    if (e.type === 'fence') audio.cheer(0.9);
    else if (e.type === 'tree' && e.down) audio.cheer(0.6);
    else if (e.type === 'overtake') audio.cheer(0.35);
    else if (e.type === 'finish') audio.cheer(1);
  }

  /** Stop playback (another view is taking the stage). */
  deactivate() {
    this.active = false;
    this.loadToken++;
    this.view3d = 'none';
    get3d()?.setVisible(false);
    this.renderer.app.stage.visible = true;
    this.center('');
    document.body.classList.remove('no-race', 'is-buffering', 'is-replay');
    $('feed').innerHTML = '';
    $('tower').innerHTML = '';
    this.race = null;
    this.record = null;
  }

  /** Show just a track (Track Lab), no race. */
  showTrack(seed: string) {
    this.bind();
    this.view3d = 'none';
    this.loadToken++;
    this.race = null;
    this.record = null;
    this.track = generateTrack(seed);
    this.renderer.setTrack(this.track);
    this.renderer.setCars([]);
    this.renderer.mode = 'overview';
    this.renderer.resetCamera();
    this.setHudVisible(false);
    this.center('');
  }

  async load(race: RaceInfo, mode: PlayMode, note?: string) {
    this.bind();
    const token = ++this.loadToken;
    this.race = race;
    this.mode = mode;
    this.record = null;
    this.verified = 'none';
    this.pendingVerify = race.results;
    this.resultsShown = false;
    this.lastEventCount = -1;
    this.track = generateTrack(race.seed);
    // Races from sim v3 on have trees + crowd fences you can crash into (older ones replay without).
    const obstacles = !race.simVersion || Number(race.simVersion) >= OBSTACLES_SINCE;
    this.ob = obstacles ? generateObstacles(this.track) : null;
    this.renderer.setTrack(this.track);
    this.renderer.setObstacles(this.ob);
    this.renderer.setCars(race.entries);
    this.push3d();
    this.renderer.selected = -1;
    this.setCamera('overview');
    this.setHudVisible(true);
    $('hud-title').textContent = race.local ? (race.slot !== null ? 'HOUSE RACE' : 'TEST RACE') : `RACE #${race.id}`;
    $('hud-live-text').textContent = mode === 'live' ? 'LIVE' : 'REPLAY';
    $('hud-progress-bar').style.width = '0';
    $('hud-seed').textContent = `seed ${race.seed}`;
    $('hud-note').textContent = note ?? '';
    $('feed').innerHTML = '';
    $('tower').innerHTML = '';
    document.body.classList.toggle('is-replay', mode === 'replay');
    this.center(`<div class="card loading" role="status"><div class="spinner"></div><div>Loading AI drivers into the sandbox…</div></div>`);

    const record = await simulate(
      { seed: race.seed, entries: race.entries, laps: race.laps ?? undefined, maxTime: MAX_RACE_SECONDS, obstacles },
      (r) => {
        if (token !== this.loadToken) return;
        $<HTMLInputElement>('replay-seek').max = String(r.duration);
        if (r.complete && this.pendingVerify) this.verify(this.pendingVerify);
      },
    );
    if (token !== this.loadToken) return;
    this.record = record;
    if (mode === 'replay') {
      this.paused = false;
      this.replaySpeed = 1;
      this.replayBase = performance.now() + 3000 / this.replaySpeed; // 3 s countdown
      this.highlightSpeed();
    }
    this.center('');
  }

  verify(stored: StoredResult[]) {
    this.pendingVerify = stored;
    const results = this.record?.results;
    if (!results) return; // checked again when the simulation completes
    const ok = stored.every((s) => results.find((r) => r.car === s.car)?.position === s.position);
    this.verified = ok ? 'yes' : 'no';
    if (this.resultsShown) this.showResults();
  }

  /** Race time in seconds (negative during the countdown). */
  raceTime(): number {
    if (!this.race) return 0;
    if (this.mode === 'live') return (Date.now() - this.race.startAt) / 1000;
    if (this.paused) return this.pausedAt;
    return ((performance.now() - this.replayBase) / 1000) * this.replaySpeed;
  }

  setCamera(mode: CameraMode, car = -1) {
    this.renderer.mode = mode;
    if (car >= 0) this.renderer.focus = car;
    // Picking a car while in 3D keeps the 3D camera (it follows the new car); map/leader buttons leave 3D.
    if (car < 0) this.view3d = 'none';
    this.paintCams();
  }

  private togglePause() {
    if (this.paused) {
      this.replayBase = performance.now() - (this.pausedAt * 1000) / this.replaySpeed;
      this.paused = false;
    } else {
      this.pausedAt = this.raceTime();
      this.paused = true;
    }
    this.updatePlayButton();
  }

  private updatePlayButton() {
    const b = $('replay-play');
    b.innerHTML = icon(this.paused ? 'play' : 'pause', 18);
    b.setAttribute('aria-label', this.paused ? 'Play' : 'Pause');
  }

  private seek(t: number) {
    if (this.paused) this.pausedAt = t;
    else this.replayBase = performance.now() - (t * 1000) / this.replaySpeed;
    this.lastEventCount = -1;
    this.resultsShown = false;
    this.center('');
  }

  private setSpeed(s: number) {
    const t = this.raceTime();
    this.replaySpeed = s;
    if (!this.paused) this.replayBase = performance.now() - (t * 1000) / s;
    this.highlightSpeed();
  }

  private highlightSpeed() {
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      const on = Number(b.dataset.speed) === this.replaySpeed;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.updatePlayButton();
  }

  replay() {
    this.mode = 'replay';
    document.body.classList.add('is-replay');
    this.paused = false;
    this.replayBase = performance.now() + 2000 / this.replaySpeed;
    this.resultsShown = false;
    this.lastEventCount = -1;
    this.center('');
  }

  private update() {
    if (!this.active) return;
    const now = performance.now();
    const dtWall = Math.min(0.1, (now - this.lastWall) / 1000);
    this.lastWall = now;
    const rec = this.record;
    if (!rec || !this.race) {
      get3d()?.setVisible(false);
      this.renderer.app.stage.visible = true;
      this.renderer.render([], [], dtWall, false);
      return;
    }
    const t = this.raceTime();
    const tc = Math.max(0, Math.min(t, rec.duration));
    const buffering = !rec.complete && t > rec.duration;
    document.body.classList.toggle('is-buffering', buffering);
    const { cars, progress } = this.sample(tc);
    const order = this.order(cars, progress, tc);
    const playing = t > 0 && t < rec.duration && !buffering && !(this.mode === 'replay' && this.paused);
    const c3 = this.view3d !== 'none' ? get3d() : null;
    if (c3 && this.pushed3d) {
      const focus = this.renderer.selected >= 0 ? this.renderer.selected : order[0];
      this.play3dEvents(c3, tc, cars);
      c3.setVisible(true);
      this.renderer.app.stage.visible = false;
      c3.render(cars, focus, playing ? dtWall : 0);
      const fc = cars[focus];
      const fan = this.view3d === 'fan';
      audio.update(playing ? fc.speed : 0, fc.flags & FLAG.braking ? 0 : 0.7, fc.slip, fan ? 1 : c3.crowdNear(cars, focus), dtWall, fan ? Math.max(0.04, 1 - c3.distanceTo(fc) / 220) : 1);
    } else {
      get3d()?.setVisible(false);
      this.renderer.app.stage.visible = true;
      this.renderer.render(cars, order, dtWall, playing);
      audio.update(0, 0, 0, 0, dtWall);
    }

    if (now - this.lastHud > 120) {
      this.lastHud = now;
      this.updateHud(t, cars, progress, order);
    }
  }

  // Reused every frame (no allocation in the render loop).
  private carBuf: CarVisual[] = [];
  private progressBuf: number[] = [];
  private orderBuf: number[] = [];

  private sample(t: number): { cars: CarVisual[]; progress: number[] } {
    const rec = this.record!;
    const n = rec.carCount,
      S = rec.stride;
    const cars = this.carBuf,
      progress = this.progressBuf;
    while (cars.length < n) cars.push({ x: 0, y: 0, h: 0, speed: 0, slip: 0, flags: 0 });
    cars.length = progress.length = n;
    const f = Math.max(0, Math.min(t * rec.frameRate, rec.frameCount - 1));
    const i0 = Math.floor(f),
      i1 = Math.min(i0 + 1, rec.frameCount - 1),
      a = f - i0;
    for (let c = 0; c < n; c++) {
      const o0 = (i0 * n + c) * S,
        o1 = (i1 * n + c) * S;
      const F = rec.frames;
      let dh = F[o1 + 2] - F[o0 + 2];
      dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI;
      const car = cars[c];
      car.x = F[o0] + (F[o1] - F[o0]) * a;
      car.y = F[o0 + 1] + (F[o1 + 1] - F[o0 + 1]) * a;
      car.h = F[o0 + 2] + dh * a;
      car.speed = F[o0 + 3] + (F[o1 + 3] - F[o0 + 3]) * a;
      car.slip = F[o0 + 4];
      car.flags = F[o0 + 7];
      progress[c] = F[o0 + 5] + (F[o1 + 5] - F[o0 + 5]) * a;
    }
    return { cars, progress };
  }

  private order(cars: CarVisual[], progress: number[], t: number): number[] {
    const fin = (i: number) => {
      const ft = this.record!.finishTimes.get(i);
      return ft !== undefined && ft <= t ? ft : null;
    };
    const order = this.orderBuf;
    order.length = cars.length;
    for (let i = 0; i < cars.length; i++) order[i] = i;
    return order.sort((a, b) => {
        const fa = fin(a),
          fb = fin(b);
        if (fa !== null && fb !== null) return fa - fb;
        if (fa !== null) return -1;
        if (fb !== null) return 1;
        return progress[b] - progress[a];
      });
  }

  private updateHud(t: number, cars: CarVisual[], progress: number[], order: number[]) {
    const rec = this.record!;
    const race = this.race!;
    const L = rec.trackLength;

    // Clock + lap
    const leader = order[0];
    const finishTimes = rec.finishTimes;
    const leaderFinished = finishTimes.has(leader) && finishTimes.get(leader)! <= t;
    const lap = Math.min(rec.laps, Math.max(1, Math.floor(progress[leader] / L) + 1));
    $('hud-lap').innerHTML = t < 0 ? `<b>${rec.laps}</b> ${rec.laps === 1 ? 'LAP' : 'LAPS'}` : leaderFinished ? 'FINISHED' : `LAP <b>${lap}</b>/${rec.laps}`;
    $('hud-clock').textContent = t < 0 ? '' : fmtTime(Math.min(t, rec.duration));
    const done = Math.max(0, Math.min(1, progress[leader] / (rec.laps * L)));
    $('hud-progress-bar').style.width = `${(leaderFinished ? 1 : done) * 100}%`;

    // Countdown / lights / results
    if (t < 0) this.renderCountdown(t);
    else if (t >= rec.duration && rec.complete) {
      if (!this.resultsShown) this.showResults();
    } else if (this.resultsShown || document.querySelector('#center .countdown')) {
      this.resultsShown = false;
      this.center('');
    }

    // Timing tower
    const winnerTime = Math.min(...finishTimes.values());
    let fastestCar = -1;
    for (const ev of rec.events) if (ev.type === 'fastest_lap' && ev.t <= t) fastestCar = ev.car;
    // Rows are kept and patched in place (not rebuilt) so clicks on them always land.
    const tower = $('tower');
    while (tower.children.length > order.length) tower.lastElementChild!.remove();
    while (tower.children.length < order.length) tower.appendChild(document.createElement('li'));
    order.forEach((i, p) => {
      const e = race.entries[i];
      const ft = finishTimes.get(i);
      const finished = ft !== undefined && ft <= t;
      const out = cars[i].flags & FLAG.stopped && !finished;
      let gap: string;
      if (out) gap = '<span class="out">OUT</span>';
      else if (finished) gap = p === 0 ? icon('flag', 14) : `+${(ft! - winnerTime).toFixed(2)}`;
      else if (p === 0) gap = t < 0 ? '' : 'LEADER';
      else {
        const m = progress[order[0]] - progress[i];
        gap = m > L ? `+${Math.floor(m / L)} LAP` : `+${(m / Math.max(cars[i].speed, 20)).toFixed(1)}`;
      }
      const li = tower.children[p] as HTMLElement;
      li.dataset.car = String(i);
      li.className = `${i === this.renderer.selected ? 'sel' : ''} ${out ? 'is-out' : ''}`;
      // Places gained/lost since the start (arrow + number, not colour alone).
      const delta = t < 0 ? 0 : rec.grid.indexOf(i) - p;
      const deltaHtml =
        delta > 0
          ? `<span class="delta up" title="Gained ${delta}">${icon('up', 12)}${delta}</span>`
          : delta < 0
            ? `<span class="delta down" title="Lost ${-delta}">${icon('down', 12)}${-delta}</span>`
            : '<span class="delta same">–</span>';
      const html = `<span class="pos">${p + 1}</span><span class="bar" style="background:${e.color}"></span>
        <span class="nm">${escapeHtml(e.name)}${i === fastestCar ? `<span class="fl" title="Fastest lap">${icon('clock', 13)}</span>` : ''}</span>
        ${deltaHtml}<span class="gap">${gap}</span>`;
      li.setAttribute('aria-label', `P${p + 1} ${e.name}. View driver code`);
      li.tabIndex = 0;
      if (li.innerHTML !== html) li.innerHTML = html;
    });

    // Event feed
    const visible = rec.events.filter((e) => e.t <= t && e.type !== 'start');
    if (visible.length !== this.lastEventCount) {
      this.lastEventCount = visible.length;
      $('feed').innerHTML = visible
        .slice(-5)
        .reverse()
        .map((e) => `<li class="ev-${e.type}">${icon(EVENT_ICON[e.type] ?? 'flag', 14)}<span class="ev-t">${fmtTime(e.t)}</span><span>${escapeHtml(e.text.replace(/^🏁\s*/u, ''))}</span></li>`)
        .join('');
    }

    if (this.mode === 'replay') {
      const seek = $<HTMLInputElement>('replay-seek');
      if (document.activeElement !== seek) seek.value = String(Math.max(0, t));
      $('replay-time').textContent = `${fmtTime(Math.max(0, Math.min(t, rec.duration)))} / ${fmtTime(rec.duration)}`;
    }
  }

  private renderCountdown(t: number) {
    const rec = this.record!;
    const race = this.race!;
    // Build once, then patch: rebuilding every tick would swallow clicks on the grid.
    if (!document.querySelector('#center .countdown')) {
      const grid = rec.grid
        .map((car, slot) => {
          const e = race.entries[car];
          return `<li data-car="${car}" tabindex="0" aria-label="Grid P${slot + 1} ${escapeHtml(e.name)}. View driver code">
            <span class="gp">P${slot + 1}</span><span class="bar" style="background:${e.color}"></span><span class="gn">${escapeHtml(e.name)}</span></li>`;
        })
        .join('');
      this.center(`
        <div class="card countdown">
          <div class="lights" aria-hidden="true">${'<span></span>'.repeat(5)}</div>
          <div class="cd-label" id="cd-label"></div>
          <div class="cd-time" id="cd-time" role="timer"></div>
          <div class="cd-sub">${rec.carCount} AI drivers · ${rec.laps} ${rec.laps === 1 ? 'lap' : 'laps'} · ${(rec.trackLength / 1000).toFixed(2)} km · ${this.track!.corners.length} corners</div>
          <div class="grid-title">STARTING GRID</div>
          <ol class="grid-list">${grid}</ol>
        </div>`);
      for (const li of document.querySelectorAll<HTMLElement>('.grid-list li')) {
        li.onclick = () => this.onSelectCar(Number(li.dataset.car));
        li.onkeydown = (ev) => {
          if (ev.key === 'Enter') this.onSelectCar(Number(li.dataset.car));
        };
      }
    }
    const secs = Math.ceil(-t);
    const lit = -t <= 5 ? Math.max(0, Math.min(5, 5 - Math.floor(-t))) : 0;
    document.querySelectorAll('.lights span').forEach((el, i) => el.classList.toggle('on', i < lit));
    $('cd-label').textContent = -t > 5 ? 'LIGHTS OUT IN' : 'GET READY';
    $('cd-time').textContent = secs >= 60 ? fmtTime(secs).slice(0, -2) : String(secs);
  }

  private showResults() {
    const rec = this.record!;
    const race = this.race!;
    this.resultsShown = true;
    const results = rec.results!;
    const win = results[0];
    const timeOf = (r: (typeof results)[number]) =>
      r.finished
        ? r.position === 1
          ? fmtTime(r.finishTime!)
          : `+${(r.finishTime! - win.finishTime!).toFixed(2)}s`
        : r.crashed
          ? `<span class="out" title="${escapeHtml(r.crashReason ?? '')}">DNF</span>`
          : `${Math.max(0, Math.round(r.progress))} m`;
    const step = (idx: number) => {
      const r = results[idx];
      if (!r) return '<div></div>';
      const e = race.entries[r.car];
      return `<div class="step p${idx + 1}" data-car="${r.car}" tabindex="0" role="button" aria-label="P${idx + 1} ${escapeHtml(e.name)}. View driver code">
        <div class="pn">P${idx + 1}</div>
        <div class="who"><span class="bar" style="background:${e.color};height:14px"></span>${escapeHtml(e.name)}</div>
        <div class="tm">${timeOf(r)}</div></div>`;
    };
    const rest = results
      .slice(3)
      .map((r) => {
        const e = race.entries[r.car];
        return `<tr data-car="${r.car}" tabindex="0"><td class="pos">${r.position}</td><td><span class="bar" style="background:${e.color}"></span>${escapeHtml(e.name)}<div class="sub">${escapeHtml(e.model)}</div></td>
          <td class="num">${timeOf(r)}</td><td class="num">${r.bestLap ? r.bestLap.toFixed(2) : '–'}</td></tr>`;
      })
      .join('');
    const badge =
      this.verified === 'yes'
        ? `<div class="verify ok">${icon('check')}Verified: your browser re-ran this race and got the same result as the server.</div>`
        : this.verified === 'no'
          ? `<div class="verify bad">${icon('alert')}Your browser's result differs from the stored result.</div>`
          : '';
    const live = this.mode === 'live' && race.slot !== null;
    const link = race.id !== null ? `#/replay/${race.id}` : race.slot !== null ? `#/replay/local/${race.slot}` : null;
    const winner = race.entries[win.car];
    this.center(`
      <div class="card results" role="dialog" aria-label="Race results">
        <div class="res-kicker">${race.id !== null ? `Race #${race.id}` : 'Race'} · Final classification</div>
        <div class="res-head">${icon('trophy', 26)}${win.finished ? `${escapeHtml(winner.name)} wins` : `${escapeHtml(winner.name)} leads at the flag`}</div>
        <div class="podium">${step(1)}${step(0)}${step(2)}</div>
        ${rest ? `<table><thead><tr><th>P</th><th>Driver</th><th>Time</th><th>Best lap</th></tr></thead><tbody>${rest}</tbody></table>` : ''}
        ${badge}
        <div class="res-foot">
          ${live ? `<span>Next race in <b id="next-in"></b></span>` : '<span></span>'}
          <div class="res-actions">
            ${link ? `<button class="btn btn-ghost small" id="btn-share">${icon('link', 14)}Copy replay link</button>` : ''}
            <button class="btn small" id="btn-replay">${icon('replay', 14)}Watch again</button>
          </div>
        </div>
      </div>`);
    $('btn-replay').onclick = () => this.replay();
    const share = document.getElementById('btn-share');
    if (share && link)
      share.onclick = async () => {
        await navigator.clipboard.writeText(location.origin + location.pathname + link);
        share.innerHTML = `${icon('check', 14)}Link copied`;
      };
    for (const el of document.querySelectorAll<HTMLElement>('.results [data-car]')) {
      el.onclick = () => this.onSelectCar(Number(el.dataset.car));
      el.onkeydown = (ev) => {
        if (ev.key === 'Enter') this.onSelectCar(Number(el.dataset.car));
      };
    }
    this.onPostRace();
  }

  center(html: string) {
    const el = $('center');
    if (el.innerHTML !== html) el.innerHTML = html;
    el.classList.toggle('show', html !== '');
  }

  private setHudVisible(v: boolean) {
    document.body.classList.toggle('no-race', !v);
    // Keep the track clear of the panels: race HUD (top bar, tower right, controls bottom) or the Track Lab panel (left).
    this.renderer.insets = v ? { top: 72, right: 300, bottom: 64, left: 16 } : { top: 16, right: 200, bottom: 16, left: 350 };
    this.renderer.resetCamera();
  }
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}
