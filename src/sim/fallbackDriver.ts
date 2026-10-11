import { botController } from './nativeBot';
// Hand-written driver used when a model fails, and for "house" cars.
// It runs in the same sandbox as model code (it's just a string), so it follows the same rules.

export interface FallbackParams {
  look: number; // lookahead multiplier
  grip: number; // how hard it pushes in corners (lateral g it assumes)
  brake: number; // how late it brakes (assumed decel)
  gain: number; // steering gain
  pass: number; // willingness to pull out and overtake (0..1)
  maxSpeed?: number; // m/s cap (limp mode)
}

// Used when a model fails: "limp mode", so a model never wins a race with someone else's code.
export const DEFAULT_FALLBACK: FallbackParams = { look: 1, grip: 11, brake: 11, gain: 2.0, pass: 0.2, maxSpeed: 20 };

export function fallbackDriverCode(p: FallbackParams = DEFAULT_FALLBACK): string {
  return `function __name(fn) { return fn; } // esbuild may emit this name helper in Node scripts.
const P = ${JSON.stringify(p)}, mem = { laneOffset: 0 };
const controller = ${botController.toString()};
function drive(state) { return controller(state, TRACK, P, mem, Math); }`;
}

/** House cars use slightly different personalities so they don't drive as a train. */
export const HOUSE_BOTS: Array<{ name: string; params: FallbackParams }> = [
  { name: 'House Bot Alpha', params: { look: 1.0, grip: 13.4, brake: 13.8, gain: 2.2, pass: 0.8 } },
  { name: 'House Bot Bravo', params: { look: 0.9, grip: 13.8, brake: 14.5, gain: 2.5, pass: 1.0 } },
  { name: 'House Bot Charlie', params: { look: 1.15, grip: 12.6, brake: 13.0, gain: 2.0, pass: 0.5 } },
  { name: 'House Bot Delta', params: { look: 1.0, grip: 14.2, brake: 15.0, gain: 2.3, pass: 0.9 } },
  { name: 'House Bot Echo', params: { look: 1.05, grip: 13.0, brake: 14.0, gain: 2.1, pass: 0.6 } },
  { name: 'House Bot Foxtrot', params: { look: 0.95, grip: 13.6, brake: 13.4, gain: 2.4, pass: 0.7 } },
  { name: 'House Bot Golf', params: { look: 1.1, grip: 14.0, brake: 14.2, gain: 2.2, pass: 0.75 } },
  { name: 'House Bot Hotel', params: { look: 0.85, grip: 12.9, brake: 13.6, gain: 2.6, pass: 0.65 } },
];

export const CAR_COLORS = [
  '#ff3b30', '#0a84ff', '#ffd60a', '#30d158', '#bf5af2',
  '#ff9f0a', '#64d2ff', '#ff375f', '#e5e5ea', '#a2845e',
];
