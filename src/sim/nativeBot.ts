// Native (non-sandboxed) bot driver used to fill empty grid slots in live multiplayer rooms.
// Same logic as fallbackDriver.ts, but plain TypeScript and only deterministic math, so the
// game server stays cheap and replays in the browser match the server bit for bit.
import { atan2, clamp, cos, PI, sin, TAU } from './dmath';
import type { DriverOutput, DriverState, DriverTrack } from './driverApi';
import type { FallbackParams } from './fallbackDriver';

export interface BotMemory {
  laneOffset: number;
}

export function nativeBotDrive(state: DriverState, T: DriverTrack, P: FallbackParams, mem: BotMemory): DriverOutput {
  const n = T.points.length,
    me = state.me;

  let desired = 0;
  for (const c of state.cars) {
    if (c.gap > 2 && c.gap < 22 && Math.abs(c.lateral - me.lateral) < 3 && (c.speed < me.speed + 1 || c.stopped)) {
      const room = me.halfWidth - 2;
      desired = c.lateral > 0 ? -room * P.pass : room * P.pass;
      break;
    }
  }
  mem.laneOffset += (desired - mem.laneOffset) * 0.08;

  const look = 9 + me.speed * 0.42 * P.look;
  const k = Math.max(2, Math.round(look / T.spacing));
  const ti = (me.trackIndex + k) % n;
  const th = T.headings[ti];
  const tx = T.points[ti][0] - sin(th) * mem.laneOffset;
  const ty = T.points[ti][1] + cos(th) * mem.laneOffset;
  let ang = atan2(ty - me.y, tx - me.x) - me.heading;
  while (ang > PI) ang -= TAU;
  while (ang < -PI) ang += TAU;
  const steer = clamp(ang * P.gain - me.vLat * 0.03, -1, 1);

  let target = P.maxSpeed || 70;
  const horizon = Math.ceil((me.speed * me.speed) / (2 * P.brake) / T.spacing + 40 / T.spacing);
  for (let j = 0; j < horizon; j++) {
    const i = (me.trackIndex + j) % n;
    const c = Math.abs(T.curvature[i]) + 1e-4;
    const vmax = Math.sqrt(P.grip / c);
    const allowed = Math.sqrt(vmax * vmax + 2 * P.brake * j * T.spacing);
    if (allowed < target) target = allowed;
  }
  if (me.offTrack) target = Math.min(target, 22);

  let throttle = 1,
    brake = 0;
  const diff = me.speed - target;
  if (diff > 0.5) {
    throttle = 0;
    brake = Math.min(1, diff / 5);
  } else if (diff > -1.5) throttle = 0.6;
  return { throttle, steer, brake };
}
