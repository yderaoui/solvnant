// Deterministic race simulation. Fixed 60 Hz physics, drivers called at 20 Hz, frames recorded at 30 Hz.
// Same seed + same driver code + same SIM_VERSION => identical race, bit for bit.
// RaceSim can be stepped in chunks so a viewer can start watching before the whole race is computed.
import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import { clamp, cos, sin, wrapAngle } from './dmath';
import { hashString, Rng } from './rng';
import { generateTrack, lapsFor, sampleTrack, type Track } from './track';
import { PHYS, collide, locate, speedOf, stepCar, type Car, type Input } from './physics';
import { DriverSandbox, loadQuickJS } from './sandbox';
import { trackForDriver, type DriverState } from './driverApi';

export const SIM_VERSION = '1';
export const FRAME_RATE = 30;
export const FRAME_STRIDE = 8; // x, y, heading, speed, slip, progress, steer, flags
export const FLAG = { offTrack: 1, stopped: 2, finished: 4, slipstream: 8, braking: 16 } as const;
const TICKS_PER_DRIVER_CALL = 3;
const TICKS_PER_FRAME = 2;

export interface Entry {
  name: string; // display name
  model: string; // model id (or house bot name)
  color: string;
  code: string;
  source: 'llm' | 'fallback' | 'house';
  driverId?: string | null;
}

export interface RaceConfig {
  seed: string;
  entries: Entry[];
  laps?: number;
  maxTime?: number; // seconds
}

export interface RaceEvent {
  t: number;
  type: 'start' | 'overtake' | 'crash' | 'wall' | 'contact' | 'fastest_lap' | 'final_lap' | 'finish' | 'dnf';
  car: number;
  other?: number;
  text: string;
}

export interface CarResult {
  car: number;
  position: number;
  finished: boolean;
  finishTime: number | null;
  bestLap: number | null;
  lapsDone: number;
  crashed: boolean;
  crashReason: string | null;
  crashTime: number | null;
  contacts: number;
  wallHits: number;
  offTracks: number;
  progress: number;
}

export interface RaceMeta {
  simVersion: string;
  seed: string;
  laps: number;
  trackLength: number;
  carCount: number;
  grid: number[]; // grid slot -> car index
  frameRate: number;
  stride: number;
  maxFrames: number;
}

export interface RaceRecord extends RaceMeta {
  frames: Float32Array;
  frameCount: number;
  duration: number;
  results: CarResult[]; // sorted by position
  events: RaceEvent[];
}

export async function simulateRace(config: RaceConfig): Promise<RaceRecord> {
  return runRace(await loadQuickJS(), config);
}

/** Simulate a whole race in one go. */
export function runRace(qjs: QuickJSWASMModule, config: RaceConfig): RaceRecord {
  const sim = new RaceSim(qjs, config);
  try {
    while (!sim.done) sim.step(600);
    return sim.record();
  } finally {
    sim.dispose();
  }
}

export class RaceSim {
  readonly meta: RaceMeta;
  readonly track: Track;
  readonly events: RaceEvent[] = [];
  readonly frames: Float32Array;
  frameCount = 0;
  done = false;
  t = 0;

  private config: RaceConfig;
  private cars: Car[];
  private boxes: DriverSandbox[];
  private inputs: Input[];
  private laps: number;
  private maxTime: number;
  private tick = 0;
  private leaderFinish: number | null = null;
  private fastest = Infinity;
  private prevOrder: number[];
  private pairCooldown = new Map<string, number>();
  private contactCooldown = new Map<number, number>();

  constructor(qjs: QuickJSWASMModule, config: RaceConfig) {
    this.config = config;
    const track = (this.track = generateTrack(config.seed));
    const laps = (this.laps = config.laps ?? lapsFor(track));
    this.maxTime = config.maxTime ?? 230;
    const L = track.length;
    const n = config.entries.length;

    // Grid order is drawn from the seed.
    const grid = new Rng(hashString('grid:' + config.seed)).shuffle([...Array(n).keys()]);
    this.cars = config.entries.map((_, i) => {
      const slot = grid.indexOf(i);
      const back = 12 + slot * 7.5;
      const p = sampleTrack(track, L - back);
      const side = slot % 2 === 0 ? -1 : 1;
      const off = side * Math.min(3.5, p.halfWidth - 2);
      return newCar(i, p.x - sin(p.heading) * off, p.y + cos(p.heading) * off, p.heading, p.index, L - back, -back, off, p.halfWidth);
    });
    for (const c of this.cars) locate(c, track);

    const trackJson = JSON.stringify(trackForDriver(track, laps));
    this.boxes = config.entries.map((e, i) => {
      const box = new DriverSandbox(qjs, hashString(`driver:${config.seed}:${i}`));
      const r = box.load(e.code, trackJson);
      if (!r.ok) {
        const c = this.cars[i];
        c.stopped = true;
        c.crashReason = r.error ?? 'failed to load';
        c.crashTime = 0;
        this.events.push({ t: 0, type: 'crash', car: i, text: `${this.name(i)} failed to start: ${c.crashReason}` });
      }
      return box;
    });

    this.inputs = this.cars.map(() => ({ throttle: 0, steer: 0, brake: 0 }));
    const maxFrames = Math.ceil(this.maxTime * FRAME_RATE) + 2;
    this.frames = new Float32Array(maxFrames * n * FRAME_STRIDE);
    this.prevOrder = standings(this.cars);
    this.events.push({ t: 0, type: 'start', car: -1, text: 'Lights out!' });
    this.meta = {
      simVersion: SIM_VERSION,
      seed: config.seed,
      laps,
      trackLength: L,
      carCount: n,
      grid,
      frameRate: FRAME_RATE,
      stride: FRAME_STRIDE,
      maxFrames,
    };
  }

  private name(i: number) {
    return this.config.entries[i].name;
  }

  /** Advance until `maxNewFrames` more frames are recorded or the race ends. */
  step(maxNewFrames: number) {
    const target = this.frameCount + maxNewFrames;
    while (!this.done && this.frameCount < target) this.tickOnce();
    if (this.done) for (const b of this.boxes) b.dispose();
  }

  private tickOnce() {
    const { cars, inputs, track, events } = this;
    const n = cars.length;
    const L = track.length;
    const laps = this.laps;
    const dt = PHYS.dt;
    const tick = this.tick;

    // --- drivers
    if (tick % TICKS_PER_DRIVER_CALL === 0) {
      const order = standings(cars);
      for (let i = 0; i < n; i++) {
        const c = cars[i];
        if (c.stopped) continue;
        const state = buildState(i, cars, order, track, this.t, laps);
        const out = this.boxes[i].call(JSON.stringify(state));
        if (!out) {
          c.stopped = true;
          if (c.finished) continue; // crashed during the cool-down lap: doesn't count
          c.crashReason = this.boxes[i].error;
          c.crashTime = this.t;
          events.push({ t: this.t, type: 'crash', car: i, text: `${this.name(i)} crashed: ${c.crashReason}` });
          continue;
        }
        inputs[i] = {
          throttle: num(out.throttle) * (c.finished ? 0.35 : 1),
          steer: num(out.steer),
          brake: num(out.brake),
        };
      }
    }

    // --- slipstream
    for (const c of cars) {
      c.slipstream = false;
      if (c.offTrack) continue;
      for (const o of cars) {
        if (o === c || o.stopped) continue;
        const gap = o.progress - c.progress;
        if (gap < 6 || gap > PHYS.slipstreamRange) continue;
        if (Math.abs(o.lateral - c.lateral) < 2.2) {
          c.slipstream = true;
          break;
        }
      }
    }

    // --- physics
    for (let i = 0; i < n; i++) stepCar(cars[i], inputs[i], dt);
    const hits = collide(cars);
    const t = (this.t = (tick + 1) * dt);
    for (const [a, b, sev] of hits) {
      if ((this.contactCooldown.get(a) ?? -9) > t - 3) continue;
      this.contactCooldown.set(a, t);
      this.contactCooldown.set(b, t);
      events.push({ t, type: 'contact', car: a, other: b, text: `Contact! ${this.name(a)} and ${this.name(b)}${sev > 12 ? ' (big hit)' : ''}` });
    }

    for (let i = 0; i < n; i++) {
      const c = cars[i];
      const { ds, hitWall } = locate(c, track);
      if (hitWall && (this.contactCooldown.get(i) ?? -9) < t - 3) {
        this.contactCooldown.set(i, t);
        events.push({ t, type: 'wall', car: i, text: `${this.name(i)} hits the wall` });
      }
      const before = c.progress;
      c.progress += ds;
      if (c.finished) continue;
      if (before < 0 && c.progress >= 0) c.lapStartTime = t;
      const lapNow = Math.floor(c.progress / L);
      if (c.progress > 0 && lapNow > c.lapsDone) {
        c.lapsDone = lapNow;
        const lapTime = t - c.lapStartTime;
        c.lapStartTime = t;
        if (c.bestLap === null || lapTime < c.bestLap) c.bestLap = lapTime;
        if (lapTime < this.fastest) {
          this.fastest = lapTime;
          events.push({ t, type: 'fastest_lap', car: i, text: `Fastest lap: ${this.name(i)} ${lapTime.toFixed(2)}s` });
        }
        if (c.lapsDone >= laps) {
          c.finished = true;
          c.finishTime = t;
          const first = this.leaderFinish === null;
          if (first) this.leaderFinish = t;
          events.push({ t, type: 'finish', car: i, text: first ? `🏁 ${this.name(i)} WINS!` : `${this.name(i)} finishes` });
        } else if (c.lapsDone === laps - 1 && standings(cars)[0] === i) {
          events.push({ t, type: 'final_lap', car: i, text: `Final lap! ${this.name(i)} leads` });
        }
      }
    }

    // --- overtakes (4 Hz)
    if (tick % 15 === 0) {
      const order = standings(cars);
      const prev = this.prevOrder;
      for (let p = 0; p < order.length; p++) {
        const a = order[p];
        const prevPos = prev.indexOf(a);
        if (prevPos <= p) continue;
        for (let q = p + 1; q < order.length; q++) {
          const b = order[q];
          if (prev.indexOf(b) >= prevPos) continue;
          if (cars[a].stopped || cars[b].stopped || cars[a].finished || cars[b].finished) continue;
          if (cars[a].progress < 0) continue;
          const key = a < b ? `${a}-${b}` : `${b}-${a}`;
          if ((this.pairCooldown.get(key) ?? -9) > t - 4) continue;
          this.pairCooldown.set(key, t);
          events.push({ t, type: 'overtake', car: a, other: b, text: `${this.name(a)} passes ${this.name(b)} for P${p + 1}` });
        }
      }
      this.prevOrder = order;
    }

    // --- record
    if (tick % TICKS_PER_FRAME === 0 && this.frameCount < this.meta.maxFrames) {
      let o = this.frameCount * n * FRAME_STRIDE;
      const F = this.frames;
      for (const c of cars) {
        F[o++] = c.x;
        F[o++] = c.y;
        F[o++] = c.h;
        F[o++] = speedOf(c);
        F[o++] = c.slip;
        F[o++] = c.progress;
        F[o++] = c.steer;
        F[o++] =
          (c.offTrack ? FLAG.offTrack : 0) |
          (c.stopped ? FLAG.stopped : 0) |
          (c.finished ? FLAG.finished : 0) |
          (c.slipstream ? FLAG.slipstream : 0) |
          (c.brake > 0.1 ? FLAG.braking : 0);
      }
      this.frameCount++;
    }

    this.tick++;
    const racing = cars.some((c) => !c.finished && !c.stopped);
    if (!racing || (this.leaderFinish !== null && t > this.leaderFinish + 25) || t >= this.maxTime) this.finish();
  }

  private finish() {
    this.done = true;
    for (const r of this.results()) {
      if (!r.finished && r.crashed) this.events.push({ t: this.t, type: 'dnf', car: r.car, text: `${this.name(r.car)}: DNF` });
    }
  }

  results(): CarResult[] {
    return standings(this.cars).map((i, p) => {
      const c = this.cars[i];
      return {
        car: i,
        position: p + 1,
        finished: c.finished,
        finishTime: c.finishTime,
        bestLap: c.bestLap,
        lapsDone: c.lapsDone,
        crashed: c.crashReason !== null,
        crashReason: c.crashReason,
        crashTime: c.crashTime,
        contacts: c.contacts,
        wallHits: c.wallHits,
        offTracks: c.offTracks,
        progress: c.progress,
      };
    });
  }

  record(): RaceRecord {
    const n = this.cars.length;
    return {
      ...this.meta,
      frames: this.frames.slice(0, this.frameCount * n * FRAME_STRIDE),
      frameCount: this.frameCount,
      duration: this.t,
      results: this.results(),
      events: this.events,
    };
  }

  dispose() {
    for (const b of this.boxes) b.dispose();
  }
}

function newCar(id: number, x: number, y: number, h: number, idx: number, s: number, progress: number, lateral: number, halfWidth: number): Car {
  return {
    id, x, y, h, vx: 0, vy: 0, steer: 0, throttle: 0, brake: 0,
    idx, s, progress, lateral, halfWidth, offTrack: false, slip: 0, slipstream: false,
    stopped: false, crashReason: null, crashTime: null, finished: false, finishTime: null,
    lapStartTime: 0, lapsDone: 0, bestLap: null, contacts: 0, wallHits: 0, offTracks: 0,
  };
}

/** Car indices in race order: finishers by time, then everyone else by distance. */
function standings(cars: Car[]): number[] {
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

function buildState(i: number, cars: Car[], order: number[], track: Track, t: number, laps: number): DriverState {
  const c = cars[i];
  const L = track.length;
  const v = speedOf(c);
  const fx = cos(c.h),
    fy = sin(c.h);
  const trackHeading = track.headings[c.idx];
  const others = [];
  for (const o of cars) {
    if (o === c) continue;
    let gap = o.progress - c.progress;
    gap = gap - L * Math.round(gap / L); // nearest around the lap (lapped cars)
    others.push({
      id: o.id,
      x: r2(o.x),
      y: r2(o.y),
      heading: r4(o.h),
      speed: r2(speedOf(o)),
      gap: r2(gap),
      lateral: r2(o.lateral),
      stopped: o.stopped,
    });
  }
  others.sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap) || a.id - b.id);
  return {
    t: r2(t),
    lap: clamp(Math.floor(c.progress / L) + 1, 1, laps),
    laps,
    position: order.indexOf(i) + 1,
    me: {
      id: i,
      x: r2(c.x),
      y: r2(c.y),
      heading: r4(c.h),
      speed: r2(v),
      vLong: r2(c.vx * fx + c.vy * fy),
      vLat: r2(-c.vx * fy + c.vy * fx),
      steer: r4(c.steer),
      trackIndex: c.idx,
      lapProgress: r4((((c.s / L) % 1) + 1) % 1),
      lateral: r2(c.lateral),
      halfWidth: r2(c.halfWidth),
      trackHeading: r4(trackHeading),
      headingError: r4(wrapAngle(trackHeading - c.h)),
      offTrack: c.offTrack,
    },
    cars: others,
  };
}

function num(v: number): number {
  return Number.isFinite(v) ? v : 0;
}
function r2(v: number) {
  return Math.round(v * 100) / 100;
}
function r4(v: number) {
  return Math.round(v * 10000) / 10000;
}
