// Hand-written driver used when a model fails, and for "house" cars.
// It runs in the same sandbox as model code (it's just a string), so it follows the same rules.

export interface FallbackParams {
  look: number; // lookahead multiplier
  grip: number; // how hard it pushes in corners (lateral g it assumes)
  brake: number; // how late it brakes (assumed decel)
  gain: number; // steering gain
  pass: number; // willingness to pull out and overtake (0..1)
}

export const DEFAULT_FALLBACK: FallbackParams = { look: 1, grip: 13.2, brake: 13.5, gain: 2.2, pass: 0.7 };

export function fallbackDriverCode(p: FallbackParams = DEFAULT_FALLBACK): string {
  return `// Fallback driver: pure-pursuit steering + curvature-based speed planning.
const P = ${JSON.stringify(p)};
let laneOffset = 0;

function drive(state) {
  const T = TRACK, n = T.points.length, me = state.me;

  // 1. Overtaking: if someone slower is close ahead in our lane, pick the side with more room.
  let desired = 0;
  for (const c of state.cars) {
    if (c.gap > 2 && c.gap < 22 && Math.abs(c.lateral - me.lateral) < 3 && (c.speed < me.speed + 1 || c.stopped)) {
      const room = me.halfWidth - 2;
      desired = c.lateral > 0 ? -room * P.pass : room * P.pass;
      break;
    }
  }
  laneOffset += (desired - laneOffset) * 0.08;

  // 2. Steering: aim at a point ahead on the (offset) centerline.
  const look = 9 + me.speed * 0.42 * P.look;
  const k = Math.max(2, Math.round(look / T.spacing));
  const ti = (me.trackIndex + k) % n;
  const th = T.headings[ti];
  const tx = T.points[ti][0] - Math.sin(th) * laneOffset;
  const ty = T.points[ti][1] + Math.cos(th) * laneOffset;
  let ang = Math.atan2(ty - me.y, tx - me.x) - me.heading;
  while (ang > Math.PI) ang -= 2 * Math.PI;
  while (ang < -Math.PI) ang += 2 * Math.PI;
  const steer = Math.max(-1, Math.min(1, ang * P.gain - me.vLat * 0.03));

  // 3. Speed: slowest speed we must reach for any curve inside our braking distance.
  let target = 70;
  const horizon = Math.ceil((me.speed * me.speed / (2 * P.brake) + 40) / T.spacing);
  for (let j = 0; j < horizon; j++) {
    const i = (me.trackIndex + j) % n;
    const c = Math.abs(T.curvature[i]) + 1e-4;
    const vmax = Math.sqrt(P.grip / c);
    const allowed = Math.sqrt(vmax * vmax + 2 * P.brake * j * T.spacing);
    if (allowed < target) target = allowed;
  }
  if (me.offTrack) target = Math.min(target, 22);

  let throttle = 1, brake = 0;
  const diff = me.speed - target;
  if (diff > 0.5) { throttle = 0; brake = Math.min(1, diff / 5); }
  else if (diff > -1.5) throttle = 0.6;
  return { throttle, steer, brake };
}
`;
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
