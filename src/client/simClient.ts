// Main-thread side of the simulation worker. A LiveRecord fills up as chunks arrive.
import type { CarResult, RaceConfig, RaceEvent, RaceMeta } from '../sim/race';

export interface LiveRecord extends RaceMeta {
  frames: Float32Array; // preallocated for the longest possible race
  frameCount: number; // frames available so far
  events: RaceEvent[];
  finishTimes: Map<number, number>;
  complete: boolean;
  duration: number; // final once complete, otherwise time simulated so far
  results: CarResult[] | null;
}

let worker: Worker | null = null;
let nextId = 1;

interface Job {
  record: LiveRecord | null;
  onMeta: (r: LiveRecord) => void;
  onUpdate: (r: LiveRecord) => void;
  onError: (e: Error) => void;
}
const jobs = new Map<number, Job>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    const job = jobs.get(msg.id);
    if (!job) return;
    if (msg.type === 'meta') {
      const m: RaceMeta = msg.meta;
      job.record = {
        ...m,
        frames: new Float32Array(m.maxFrames * m.carCount * m.stride),
        frameCount: 0,
        events: [],
        finishTimes: new Map(),
        complete: false,
        duration: 0,
        results: null,
      };
      job.onMeta(job.record);
      return;
    }
    if (msg.type === 'error') {
      jobs.delete(msg.id);
      return job.onError(new Error(msg.error));
    }
    const r = job.record!;
    if (msg.type === 'chunk') {
      r.frames.set(msg.frames, r.frameCount * r.carCount * r.stride);
      r.frameCount = msg.frameCount;
      r.duration = (r.frameCount - 1) / r.frameRate;
    }
    for (const ev of msg.events as RaceEvent[]) {
      r.events.push(ev);
      if (ev.type === 'finish') r.finishTimes.set(ev.car, ev.t);
    }
    if (msg.type === 'end') {
      r.complete = true;
      r.duration = msg.duration;
      r.results = msg.results;
      jobs.delete(msg.id);
    }
    job.onUpdate(r);
  };
  return worker;
}

/**
 * Start simulating a race. Resolves with the (still filling) record as soon as the first metadata
 * arrives; `onUpdate` fires for every chunk. Starting a new simulation cancels the previous one.
 */
export function simulate(config: RaceConfig, onUpdate: (r: LiveRecord) => void = () => {}): Promise<LiveRecord> {
  const id = nextId++;
  for (const k of jobs.keys()) jobs.delete(k);
  return new Promise((resolve, reject) => {
    jobs.set(id, { record: null, onMeta: resolve, onUpdate, onError: reject });
    getWorker().postMessage({ id, config });
  });
}
