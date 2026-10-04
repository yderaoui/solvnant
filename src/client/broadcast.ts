// Plays a simulated race as a broadcast: countdown, live timing tower, lap counter,
// event feed and a results card. Live mode is locked to the wall clock (everyone watching
// sees the same moment); replay mode has play/pause/seek/speed.
import { generateTrack, type Track } from '../sim/track';
import { FLAG } from '../sim/race';
import { MAX_RACE_SECONDS } from '../sim/schedule';
import { RaceRenderer, type CameraMode, type CarVisual } from './renderer';
import { simulate, type LiveRecord } from './simClient';
import { escapeHtml } from './codeViewer';
import type { RaceInfo, StoredResult } from './data';

export type PlayMode = 'live' | 'replay';

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

  constructor(public renderer: RaceRenderer) {
    renderer.onCarClick = (i) => this.onSelectCar(i);
    $('cam-overview').onclick = () => this.setCamera('overview');
    $('cam-leader').onclick = () => this.setCamera('leader');
    $('replay-play').onclick = () => this.togglePause();
    $<HTMLInputElement>('replay-seek').oninput = (e) => this.seek(Number((e.target as HTMLInputElement).value));
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      b.onclick = () => this.setSpeed(Number(b.dataset.speed));
    }
    renderer.app.ticker.add(() => this.update());
  }

  /** Show just a track (Track Lab), no race. */
  showTrack(seed: string) {
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
    const token = ++this.loadToken;
    this.race = race;
    this.mode = mode;
    this.record = null;
    this.verified = 'none';
    this.pendingVerify = race.results;
    this.resultsShown = false;
    this.lastEventCount = -1;
    this.track = generateTrack(race.seed);
    this.renderer.setTrack(this.track);
    this.renderer.setCars(race.entries);
    this.renderer.selected = -1;
    this.setCamera('overview');
    this.setHudVisible(true);
    $('hud-title').textContent = race.local ? (race.slot !== null ? 'HOUSE RACE' : 'TEST RACE') : `RACE #${race.id}`;
    $('hud-seed').textContent = `seed ${race.seed}`;
    $('hud-note').textContent = note ?? '';
    $('feed').innerHTML = '';
    $('tower').innerHTML = '';
    document.body.classList.toggle('is-replay', mode === 'replay');
    this.center(`<div class="loading"><div class="spinner"></div><div>Loading drivers into the sandbox…</div></div>`);

    const record = await simulate(
      { seed: race.seed, entries: race.entries, laps: race.laps ?? undefined, maxTime: MAX_RACE_SECONDS },
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
    for (const id of ['cam-overview', 'cam-leader']) $(id).classList.toggle('active', id === `cam-${mode}`);
  }

  private togglePause() {
    if (this.paused) {
      this.replayBase = performance.now() - (this.pausedAt * 1000) / this.replaySpeed;
      this.paused = false;
    } else {
      this.pausedAt = this.raceTime();
      this.paused = true;
    }
    $('replay-play').textContent = this.paused ? '▶' : '❚❚';
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
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) b.classList.toggle('active', Number(b.dataset.speed) === this.replaySpeed);
    $('replay-play').textContent = this.paused ? '▶' : '❚❚';
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
    const now = performance.now();
    const dtWall = Math.min(0.1, (now - this.lastWall) / 1000);
    this.lastWall = now;
    const rec = this.record;
    if (!rec || !this.race) {
      this.renderer.render([], -1, dtWall, false);
      return;
    }
    const t = this.raceTime();
    const tc = Math.max(0, Math.min(t, rec.duration));
    const buffering = !rec.complete && t > rec.duration;
    document.body.classList.toggle('is-buffering', buffering);
    const { cars, progress } = this.sample(tc);
    const order = this.order(cars, progress, tc);
    const playing = t > 0 && t < rec.duration && !buffering && !(this.mode === 'replay' && this.paused);
    this.renderer.render(cars, order[0], dtWall, playing);

    if (now - this.lastHud > 120) {
      this.lastHud = now;
      this.updateHud(t, cars, progress, order);
    }
  }

  private sample(t: number): { cars: CarVisual[]; progress: number[] } {
    const rec = this.record!;
    const n = rec.carCount,
      S = rec.stride;
    const f = Math.max(0, Math.min(t * rec.frameRate, rec.frameCount - 1));
    const i0 = Math.floor(f),
      i1 = Math.min(i0 + 1, rec.frameCount - 1),
      a = f - i0;
    const cars: CarVisual[] = [];
    const progress: number[] = [];
    for (let c = 0; c < n; c++) {
      const o0 = (i0 * n + c) * S,
        o1 = (i1 * n + c) * S;
      const F = rec.frames;
      let dh = F[o1 + 2] - F[o0 + 2];
      dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI;
      cars.push({
        x: F[o0] + (F[o1] - F[o0]) * a,
        y: F[o0 + 1] + (F[o1 + 1] - F[o0 + 1]) * a,
        h: F[o0 + 2] + dh * a,
        speed: F[o0 + 3] + (F[o1 + 3] - F[o0 + 3]) * a,
        slip: F[o0 + 4],
        flags: F[o0 + 7],
      });
      progress.push(F[o0 + 5] + (F[o1 + 5] - F[o0 + 5]) * a);
    }
    return { cars, progress };
  }

  private order(cars: CarVisual[], progress: number[], t: number): number[] {
    const fin = (i: number) => {
      const ft = this.record!.finishTimes.get(i);
      return ft !== undefined && ft <= t ? ft : null;
    };
    return cars
      .map((_, i) => i)
      .sort((a, b) => {
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
    $('hud-lap').innerHTML = t < 0 ? `<b>${rec.laps}</b> LAPS` : leaderFinished ? 'FINISHED' : `LAP <b>${lap}</b>/${rec.laps}`;
    $('hud-clock').textContent = t < 0 ? '' : fmtTime(Math.min(t, rec.duration));

    // Countdown / lights / results
    if (t < 0) {
      const secs = Math.ceil(-t);
      const lights = Math.max(0, Math.min(5, 5 - Math.floor(-t)));
      this.center(`
        <div class="countdown">
          <div class="lights">${[0, 1, 2, 3, 4].map((i) => `<span class="${i < lights && -t <= 5 ? 'on' : ''}"></span>`).join('')}</div>
          <div class="cd-label">${-t > 5 ? 'LIGHTS OUT IN' : 'GET READY'}</div>
          <div class="cd-time">${secs >= 60 ? fmtTime(secs).slice(0, -2) : secs}</div>
          <div class="cd-sub">${rec.carCount} AI drivers · ${rec.laps} laps · ${(L / 1000).toFixed(2)} km · ${this.track!.corners.length} corners</div>
        </div>`);
    } else if (t >= rec.duration && rec.complete) {
      if (!this.resultsShown) this.showResults();
    } else if (this.resultsShown || $('center').innerHTML.includes('countdown')) {
      this.resultsShown = false;
      this.center('');
    }

    // Timing tower
    const winnerTime = Math.min(...finishTimes.values());
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
      else if (finished) gap = p === 0 ? '🏁' : `+${(ft! - winnerTime).toFixed(2)}`;
      else if (p === 0) gap = t < 0 ? '' : 'LEADER';
      else {
        const m = progress[order[0]] - progress[i];
        gap = m > L ? `+${Math.floor(m / L)} LAP` : `+${(m / Math.max(cars[i].speed, 20)).toFixed(1)}`;
      }
      const li = tower.children[p] as HTMLElement;
      li.dataset.car = String(i);
      li.className = `${i === this.renderer.selected ? 'sel' : ''} ${out ? 'is-out' : ''}`;
      const html = `<span class="pos">${p + 1}</span><span class="bar" style="background:${e.color}"></span>
        <span class="nm">${escapeHtml(e.name)}${e.source === 'fallback' ? ' <i title="model failed - fallback driver">⚠</i>' : ''}</span>
        <span class="gap">${gap}</span>`;
      if (li.innerHTML !== html) li.innerHTML = html;
    });

    // Event feed
    const visible = rec.events.filter((e) => e.t <= t && e.type !== 'start');
    if (visible.length !== this.lastEventCount) {
      this.lastEventCount = visible.length;
      $('feed').innerHTML = visible
        .slice(-5)
        .reverse()
        .map((e) => `<li class="ev-${e.type}"><span class="ev-t">${fmtTime(e.t)}</span>${escapeHtml(e.text)}</li>`)
        .join('');
    }

    if (this.mode === 'replay') {
      const seek = $<HTMLInputElement>('replay-seek');
      if (document.activeElement !== seek) seek.value = String(Math.max(0, t));
      $('replay-time').textContent = `${fmtTime(Math.max(0, Math.min(t, rec.duration)))} / ${fmtTime(rec.duration)}`;
    }
  }

  private showResults() {
    const rec = this.record!;
    const race = this.race!;
    this.resultsShown = true;
    const results = rec.results!;
    const win = results[0];
    const rows = results
      .map((r) => {
        const e = race.entries[r.car];
        const status = r.finished
          ? r.position === 1
            ? fmtTime(r.finishTime!)
            : `+${(r.finishTime! - win.finishTime!).toFixed(2)}s`
          : r.crashed
            ? `<span class="out" title="${escapeHtml(r.crashReason ?? '')}">DNF · crashed</span>`
            : `${r.lapsDone}/${rec.laps} laps`;
        return `<tr data-car="${r.car}"><td class="pos">${r.position}</td><td><span class="bar" style="background:${e.color}"></span>${escapeHtml(e.name)}<div class="sub">${escapeHtml(e.model)}</div></td>
          <td>${status}</td><td>${r.bestLap ? r.bestLap.toFixed(2) : '–'}</td></tr>`;
      })
      .join('');
    const badge =
      this.verified === 'yes'
        ? '<div class="verify ok">✓ Verified: your browser re-ran this race and got the same result as the server.</div>'
        : this.verified === 'no'
          ? '<div class="verify bad">⚠ Your result differs from the stored result.</div>'
          : '';
    const live = this.mode === 'live' && race.slot !== null;
    this.center(`
      <div class="results">
        <div class="res-head">${win.finished ? '🏆 ' + escapeHtml(race.entries[win.car].name) + ' wins' : 'Race over'}</div>
        <table><thead><tr><th>P</th><th>Driver</th><th>Time</th><th>Best lap</th></tr></thead><tbody>${rows}</tbody></table>
        ${badge}
        <div class="res-foot">
          ${live ? `<span>Next race in <b id="next-in"></b></span>` : ''}
          <button class="btn" id="btn-replay">↺ Replay</button>
        </div>
      </div>`);
    $('btn-replay').onclick = () => this.replay();
    for (const tr of document.querySelectorAll<HTMLElement>('.results tr[data-car]')) tr.onclick = () => this.onSelectCar(Number(tr.dataset.car));
    this.onPostRace();
  }

  center(html: string) {
    const el = $('center');
    if (el.innerHTML !== html) el.innerHTML = html;
    el.classList.toggle('show', html !== '');
  }

  private setHudVisible(v: boolean) {
    document.body.classList.toggle('no-race', !v);
  }
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}
