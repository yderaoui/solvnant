// Runs the deterministic race simulation off the main thread and streams frames back in chunks,
// so playback can start long before the whole race has been computed.
import { RaceSim, type RaceConfig } from '../sim/race';
import { loadQuickJS } from '../sim/quickjs';

const CHUNK_FRAMES = 90; // 3 seconds of race per message
let current = 0;

self.onmessage = async (e: MessageEvent<{ id: number; config?: RaceConfig; cancel?: boolean }>) => {
  const { id, config } = e.data;
  current = id;
  if (!config) return;
  const post = (msg: any, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage({ id, ...msg }, transfer);
  let sim: RaceSim | null = null;
  try {
    sim = new RaceSim(await loadQuickJS(), config);
    post({ type: 'meta', meta: sim.meta });
    const n = sim.meta.carCount * sim.meta.stride;
    let sentFrames = 0,
      sentEvents = 0;
    while (!sim.done) {
      sim.step(CHUNK_FRAMES);
      const frames = sim.frames.slice(sentFrames * n, sim.frameCount * n);
      post({ type: 'chunk', frames, events: sim.events.slice(sentEvents), frameCount: sim.frameCount }, [frames.buffer]);
      sentFrames = sim.frameCount;
      sentEvents = sim.events.length;
      // Let a newer request (or cancel) in.
      await new Promise((r) => setTimeout(r, 0));
      if (current !== id) return;
    }
    post({ type: 'end', results: sim.results(), duration: sim.t, events: sim.events.slice(sentEvents) });
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  } finally {
    sim?.dispose();
  }
};
