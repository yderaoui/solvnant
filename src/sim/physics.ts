// Arcade car physics: grip-limited cornering (friction circle), drift/scrub when grip runs out,
// off-track slowdown, a wall at the edge of the runoff, slipstream, and car-to-car collisions.
// Uses only deterministic math (see dmath.ts).
import { clamp, cos, sin } from './dmath';
import type { Track } from './track';

export const PHYS = {
  dt: 1 / 60,
  wheelbase: 2.7,
  carLength: 4.6,
  carWidth: 2.0,
  maxSteer: 0.42, // rad at full lock (low speed)
  steerRate: 3.4, // normalized steer units per second
  engineAccel: 11,
  topSpeed: 62,
  brakeDecel: 18,
  grip: 14.5, // m/s^2 lateral
  aeroDrag: 0.0009, // * v^2
  rollDrag: 0.06, // * v
  offTrackGrip: 0.55,
  offTrackTop: 24,
  offTrackDrag: 0.9, // * v, extra
  runoff: 25, // m beyond the edge to the wall
  slipstreamRange: 35,
  slipstreamBoost: 0.07,
  // Collision: two circles per car along its length
  circleOffset: 1.25,
  circleRadius: 1.05,
  restitution: 0.35,
};

export interface Car {
  id: number;
  x: number;
  y: number;
  h: number;
  vx: number;
  vy: number;
  steer: number; // actual, -1..1
  throttle: number;
  brake: number;
  // track-relative
  idx: number;
  s: number; // arc length position on the lap, 0..L
  progress: number; // total distance along the race (negative on the grid)
  lateral: number;
  halfWidth: number;
  offTrack: boolean;
  slip: number; // sideways sliding speed, m/s
  slipstream: boolean;
  // race status
  stopped: boolean;
  crashReason: string | null;
  crashTime: number | null;
  finished: boolean;
  finishTime: number | null;
  lapStartTime: number;
  lapsDone: number;
  bestLap: number | null;
  contacts: number;
  wallHits: number;
  offTracks: number;
}

export interface Input {
  throttle: number;
  steer: number;
  brake: number;
}

export function speedOf(c: Car): number {
  return Math.sqrt(c.vx * c.vx + c.vy * c.vy);
}

/** Integrate one car for one fixed step. */
export function stepCar(car: Car, input: Input, dt: number) {
  const P = PHYS;
  const gripMul = car.offTrack ? P.offTrackGrip : 1;
  const grip = P.grip * gripMul;
  let top = car.offTrack ? P.offTrackTop : P.topSpeed;
  if (car.slipstream) top *= 1 + P.slipstreamBoost;

  const throttle = car.stopped ? 0 : clamp(input.throttle, 0, 1);
  const brake = car.stopped ? 1 : clamp(input.brake, 0, 1);
  const target = car.stopped ? car.steer : clamp(input.steer, -1, 1);
  car.steer += clamp(target - car.steer, -P.steerRate * dt, P.steerRate * dt);
  car.throttle = throttle;
  car.brake = brake;

  let fx = cos(car.h),
    fy = sin(car.h);
  let vLong = car.vx * fx + car.vy * fy;

  // Yaw: kinematic bicycle, limited so the car can rotate a bit faster than grip allows (drift).
  const v = Math.abs(vLong);
  const steerAngle = (car.steer * P.maxSteer) / (1 + v / 45); // speed-sensitive steering
  let yawRate = (vLong * steerAngle) / P.wheelbase;
  const yawLimit = (grip * 1.35) / Math.max(v, 3) + 0.15;
  yawRate = clamp(yawRate, -yawLimit, yawLimit);
  car.h += yawRate * dt;

  fx = cos(car.h);
  fy = sin(car.h);
  const rx = -fy,
    ry = fx;
  vLong = car.vx * fx + car.vy * fy;
  let vLat = car.vx * rx + car.vy * ry;

  // Longitudinal
  let aLong = throttle * P.engineAccel * (1 - Math.max(vLong, 0) / top);
  if (vLong > top) aLong = Math.min(aLong, 0);
  if (vLong > 0.05) aLong -= brake * P.brakeDecel * gripMul;
  else if (vLong < -0.05) aLong += brake * P.brakeDecel * gripMul;
  const traction = grip * 1.25;
  aLong = clamp(aLong, -traction, traction);
  aLong -= P.aeroDrag * vLong * Math.abs(vLong) + P.rollDrag * vLong;
  if (car.offTrack) aLong -= P.offTrackDrag * vLong;
  let newLong = vLong + aLong * dt;
  if (vLong > 0 && newLong < 0 && throttle === 0) newLong = 0; // brakes don't reverse the car
  if (vLong < 0 && newLong > 0 && throttle === 0) newLong = 0;

  // Lateral: tires kill sideways velocity up to the grip left over from braking/acceleration.
  const usage = Math.min(1, Math.abs(aLong) / traction);
  const latAvail = grip * Math.sqrt(Math.max(0.2, 1 - usage * usage));
  const maxDv = latAvail * dt;
  if (Math.abs(vLat) <= maxDv) {
    vLat = 0;
    car.slip = 0;
  } else {
    vLat -= Math.sign(vLat) * maxDv;
    car.slip = Math.abs(vLat);
    // Sliding scrubs speed.
    newLong *= 1 - Math.min(0.6, 0.35 * Math.min(1, car.slip / 6)) * dt;
  }

  car.vx = fx * newLong + rx * vLat;
  car.vy = fy * newLong + ry * vLat;
  car.x += car.vx * dt;
  car.y += car.vy * dt;
}

/**
 * Update the car's track-relative position (local search around the last index, so short-cuts
 * across the infield are not rewarded). Returns the capped arc-length delta since last time.
 */
export function locate(car: Car, track: Track): { ds: number; hitWall: boolean } {
  const N = track.points.length;
  const pts = track.points;
  let best = car.idx,
    bestD = Infinity;
  for (let k = -12; k <= 12; k++) {
    const i = (((car.idx + k) % N) + N) % N;
    const dx = car.x - pts[i][0],
      dy = car.y - pts[i][1];
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  // Project onto the better neighbouring segment.
  let segI = best,
    t = 0,
    bestSegD = Infinity,
    projX = pts[best][0],
    projY = pts[best][1],
    dirX = 1,
    dirY = 0;
  for (const i of [(best - 1 + N) % N, best]) {
    const a = pts[i],
      b = pts[(i + 1) % N];
    const sx = b[0] - a[0],
      sy = b[1] - a[1];
    const len2 = sx * sx + sy * sy || 1;
    const tt = clamp(((car.x - a[0]) * sx + (car.y - a[1]) * sy) / len2, 0, 1);
    const px = a[0] + sx * tt,
      py = a[1] + sy * tt;
    const d = (car.x - px) * (car.x - px) + (car.y - py) * (car.y - py);
    if (d < bestSegD) {
      bestSegD = d;
      segI = i;
      t = tt;
      projX = px;
      projY = py;
      const len = Math.sqrt(len2);
      dirX = sx / len;
      dirY = sy / len;
    }
  }
  car.idx = best;
  const L = track.length;
  const s = (segI + t) * track.spacing;
  let ds = s - car.s;
  if (ds > L / 2) ds -= L;
  if (ds < -L / 2) ds += L;
  car.s = s;
  // + = right of the direction of travel
  car.lateral = dirX * (car.y - projY) - dirY * (car.x - projX);
  const w0 = track.widths[segI],
    w1 = track.widths[(segI + 1) % N];
  car.halfWidth = (w0 + (w1 - w0) * t) / 2;
  const wasOff = car.offTrack;
  car.offTrack = Math.abs(car.lateral) > car.halfWidth + 0.6; // allow wheels on the kerb
  if (car.offTrack && !wasOff) car.offTracks++;

  // Wall at the edge of the runoff.
  const wall = car.halfWidth + PHYS.runoff;
  let hitWall = false;
  if (Math.abs(car.lateral) > wall) {
    const nx = -dirY,
      ny = dirX; // right normal
    const side = Math.sign(car.lateral);
    const excess = Math.abs(car.lateral) - wall;
    car.x -= nx * side * excess;
    car.y -= ny * side * excess;
    car.lateral = side * wall;
    const vn = (car.vx * nx + car.vy * ny) * side;
    if (vn > 0) {
      car.vx -= nx * side * vn * 1.3;
      car.vy -= ny * side * vn * 1.3;
    }
    car.vx *= 0.75;
    car.vy *= 0.75;
    hitWall = vn > 3;
    if (hitWall) car.wallHits++;
  }
  // Cap progress gain so leaving the track never pays off.
  return { ds: clamp(ds, -3, 2.2), hitWall };
}

/** Resolve car-to-car overlaps. Returns pairs that hit hard (for events). */
export function collide(cars: Car[]): Array<[number, number, number]> {
  const P = PHYS;
  const hits: Array<[number, number, number]> = [];
  const minD = P.circleRadius * 2;
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i];
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j];
      const dx0 = b.x - a.x,
        dy0 = b.y - a.y;
      if (dx0 * dx0 + dy0 * dy0 > 36) continue;
      let worst = 0;
      for (const oa of [-P.circleOffset, P.circleOffset]) {
        for (const ob of [-P.circleOffset, P.circleOffset]) {
          const ax = a.x + cos(a.h) * oa,
            ay = a.y + sin(a.h) * oa;
          const bx = b.x + cos(b.h) * ob,
            by = b.y + sin(b.h) * ob;
          const dx = bx - ax,
            dy = by - ay;
          const d2 = dx * dx + dy * dy;
          if (d2 >= minD * minD || d2 < 1e-9) continue;
          const d = Math.sqrt(d2);
          const nx = dx / d,
            ny = dy / d;
          const overlap = minD - d;
          a.x -= (nx * overlap) / 2;
          a.y -= (ny * overlap) / 2;
          b.x += (nx * overlap) / 2;
          b.y += (ny * overlap) / 2;
          const vrel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (vrel < 0) {
            const J = (-(1 + P.restitution) * vrel) / 2;
            a.vx -= J * nx;
            a.vy -= J * ny;
            b.vx += J * nx;
            b.vy += J * ny;
            // A glancing hit unsettles both cars a little.
            a.h -= 0.01 * J * Math.sign(nx * -sin(a.h) + ny * cos(a.h));
            b.h += 0.01 * J * Math.sign(nx * -sin(b.h) + ny * cos(b.h));
            worst = Math.max(worst, -vrel);
          }
        }
      }
      if (worst > 0) {
        if (worst > 2) {
          a.contacts++;
          b.contacts++;
        }
        if (worst > 6) hits.push([i, j, worst]);
      }
    }
  }
  return hits;
}
