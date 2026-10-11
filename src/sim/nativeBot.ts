// Native (non-sandboxed) bot driver used to fill empty grid slots in live multiplayer rooms.
// Same logic as fallbackDriver.ts, but plain TypeScript and only deterministic math, so the
// game server stays cheap and replays in the browser match the server bit for bit.
import { atan2, clamp, cos, PI, sin, TAU } from './dmath';
import type { DriverOutput, DriverState, DriverTrack } from './driverApi';
import type { FallbackParams } from './fallbackDriver';

export interface BotMemory {
  laneOffset: number;
  stuckCalls?: number;
  reverseCalls?: number;
}

export function legacyBotDrive(state: DriverState, T: DriverTrack, P: FallbackParams, mem: BotMemory): DriverOutput {
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


/** Pursuit uses the bicycle model, anticipates braking, and gives recovering cars room. */
export function botController(state: DriverState, T: DriverTrack, P: FallbackParams, mem: BotMemory, M: Pick<Math, "sin" | "cos" | "atan2">): DriverOutput {
  function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
  const PI = Math.PI, TAU = 2 * PI;
  const me = state.me, n = T.points.length;
  const recovering = me.offTrack || Math.abs(me.headingError) > 0.65;
  let desired = 0;
  let following = Infinity;
  for (const car of state.cars) {
    if (car.gap <= 0 || car.gap > 38) continue;
    if (Math.abs(car.lateral - me.lateral) > 3.2) continue;
    const room = Math.max(0, me.halfWidth - 2.8);
    const lane = car.lateral > 0 ? -room * P.pass : room * P.pass;
    const blocked = state.cars.some(other => other.id !== car.id && Math.abs(other.gap) < 12 && Math.abs(other.lateral - lane) < 3);
    if (!recovering && !blocked) desired = lane;
    if (blocked || recovering || Math.abs(lane - car.lateral) < 3) following = Math.min(following, Math.max(5, car.speed + (car.gap - 8) * 0.65));
    break;
  }
  mem.laneOffset += clamp(desired - mem.laneOffset, -0.16, 0.16);
  const look = recovering ? 12 : clamp(10 + me.speed * 0.55 * P.look, 12, 38);
  const arc = me.lapProgress * T.length + look;
  const f = arc / T.spacing, i = Math.floor(f) % n, j = (i + 1) % n, blend = f - Math.floor(f);
  const th = T.headings[i];
  const tx = T.points[i][0] + (T.points[j][0] - T.points[i][0]) * blend - M.sin(th) * mem.laneOffset;
  const ty = T.points[i][1] + (T.points[j][1] - T.points[i][1]) * blend + M.cos(th) * mem.laneOffset;
  const dx = tx - me.x, dy = ty - me.y;
  let ang = M.atan2(dy, dx) - me.heading;
  while (ang > PI) ang -= TAU;
  while (ang < -PI) ang += TAU;
  const distance = Math.max(5, Math.sqrt(dx * dx + dy * dy));
  const steer = Math.abs(ang) > 1.2 ? Math.sign(ang) : clamp((2 * 2.7 * M.sin(ang) / distance) * (1 + me.speed / 45) / 0.42 - me.vLat * 0.018, -1, 1);
  let target = Math.min(P.maxSpeed || 58, following);
  const decel = Math.min(11, P.brake * 0.75);
  const horizon = Math.ceil((me.speed * me.speed / (2 * decel) + 55) / T.spacing);
  for (let k = 0; k < horizon; k++) {
    const curvature = Math.abs(T.curvature[(me.trackIndex + k) % n]) + 0.0001;
    const cornerSpeed = Math.sqrt(Math.min(12.5, P.grip * 0.88) / curvature);
    target = Math.min(target, Math.sqrt(cornerSpeed * cornerSpeed + 2 * decel * Math.max(0, k * T.spacing - 12)));
  }
  if (recovering) target = Math.min(target, me.offTrack ? 12 : 17);
  if (Math.abs(ang) > 0.8) target = Math.min(target, 8);
  mem.stuckCalls = state.t > 2 && me.speed < 1.5 && recovering ? (mem.stuckCalls ?? 0) + 1 : 0;
  if ((mem.stuckCalls ?? 0) > 30) { mem.reverseCalls = 20; mem.stuckCalls = 0; }
  if ((mem.reverseCalls ?? 0) > 0) {
    mem.reverseCalls = (mem.reverseCalls ?? 0) - 1;
    return { throttle: 0, brake: 1, steer: -steer };
  }
  const diff = me.speed - target;
  return { steer, throttle: diff > 0.2 ? 0 : clamp((target - me.speed) / 4, 0.15, 1), brake: diff > 0.2 ? clamp(diff / 4, 0, 1) : 0 };
}

export function nativeBotDrive(state: DriverState, T: DriverTrack, P: FallbackParams, mem: BotMemory): DriverOutput {
  return botController(state, T, P, mem, { sin, cos, atan2 });
}
