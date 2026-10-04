// The contract between the race engine and driver code (written by LLMs or users).
import type { Corner, Track, Vec } from './track';

export interface DriverOutput {
  throttle: number; // 0..1
  steer: number; // -1 (full left) .. 1 (full right)
  brake: number; // 0..1
}

export interface OtherCar {
  id: number;
  x: number;
  y: number;
  heading: number;
  speed: number;
  gap: number; // meters along the track, + = ahead of me
  lateral: number; // their offset from the centerline, m (+ = right)
  stopped: boolean;
}

export interface DriverState {
  t: number; // seconds since the start
  lap: number; // current lap, 1-based
  laps: number; // total laps
  position: number; // current race position, 1-based
  me: {
    id: number;
    x: number;
    y: number;
    heading: number; // rad
    speed: number; // m/s
    vLong: number; // forward speed, m/s
    vLat: number; // sideways speed (sliding), m/s, + = right
    steer: number; // actual current steering, -1..1
    trackIndex: number; // nearest centerline point
    lapProgress: number; // 0..1
    lateral: number; // offset from centerline, m (+ = right)
    halfWidth: number; // half track width here, m
    trackHeading: number; // track direction here, rad
    headingError: number; // trackHeading - heading, wrapped to [-PI, PI]; positive -> steer right
    offTrack: boolean;
  };
  cars: OtherCar[]; // other cars, nearest first
}

/** Read-only global `TRACK` available inside driver code. */
export interface DriverTrack {
  points: Vec[];
  widths: number[];
  headings: number[];
  curvature: number[];
  spacing: number;
  length: number;
  laps: number;
  corners: Corner[];
}

export function trackForDriver(track: Track, laps: number): DriverTrack {
  return {
    points: track.points,
    widths: track.widths,
    headings: track.headings,
    curvature: track.curvature,
    spacing: track.spacing,
    length: track.length,
    laps,
    corners: track.corners,
  };
}

/** The spec sent to models. Keep in sync with the types above and physics constants. */
export const DRIVER_SPEC = `
# AI Grand Prix: driver API

Write ONE JavaScript function: \`function drive(state) { ... return { throttle, steer, brake }; }\`
It is called 20 times per second for your car during a top-down 2D race against up to 9 other cars.

## Coordinates
- Meters. +x = east, +y = south (screen coordinates, y points DOWN).
- heading in radians: 0 = +x, PI/2 = +y. Increasing heading = turning RIGHT (clockwise on screen).
- steer > 0 turns right (heading increases), steer < 0 turns left.

## Output (clamped; NaN/missing -> 0)
- throttle: 0..1, brake: 0..1, steer: -1..1. There is no reverse gear.

## Global TRACK (read-only, same for the whole race)
TRACK = {
  points: [[x,y], ...],   // closed centerline loop, direction of travel = increasing index, index 0 = start/finish
  widths: [m, ...],       // full track width at each point (12-20 m)
  headings: [rad, ...],   // direction of travel at each point
  curvature: [1/m, ...],  // signed; + = right-hander, - = left-hander; radius = 1/|curvature|
  spacing: m,             // distance between consecutive points (~8 m)
  length: m, laps: n,
  corners: [{ id, start, apex, end, direction: "left"|"right", radius, angle /*deg*/, distance }]
}
Look ahead with TRACK.points[(state.me.trackIndex + k) % TRACK.points.length].

## state (new object every call)
{
  t, lap, laps, position,
  me: { id, x, y, heading, speed, vLong, vLat, steer, trackIndex, lapProgress, lateral /* + = right of centerline */,
        halfWidth, trackHeading, headingError /* trackHeading - heading, wrapped; >0 means steer right */, offTrack },
  cars: [{ id, x, y, heading, speed, gap /* m along track, + = ahead */, lateral, stopped }]  // nearest first
}

## Physics (approximate)
- Top speed ~62 m/s on track. Engine accel ~11 m/s^2 at low speed, fading toward top speed.
- Braking ~18 m/s^2. Lateral grip ~14.5 m/s^2: max corner speed ~ sqrt(14.5 * radius).
  Braking and cornering share grip (friction circle). Exceed grip -> the car slides wide and scrubs speed.
- Steering responds with lag (~0.3 s from 0 to full lock). Steering is speed-sensitive.
- Off track (|lateral| > halfWidth): grip x0.55, top speed ~24 m/s. A wall sits 25 m beyond the track edge.
- Slipstream: within ~35 m directly behind another car you get a top-speed boost.
- Car-to-car contact pushes cars apart; cars are ~4.6 m x 2 m.

## Common mistakes (avoid these)
- state.cars contains cars BEHIND you too (gap < 0). Only cars with gap > 0 are ahead of you.
- Don't drive at corner speed all the time. Brake only when a slow section is within braking distance:
  for each point j ahead, allowed = sqrt(vCorner_j^2 + 2 * decel * distance_j); target speed = the minimum of those.
- Steering only on headingError makes the car drift wide. Steer toward a point 10-30 m ahead on the centerline
  (further at higher speed), and correct for state.me.lateral.
- Use full throttle on straights: accelerating back up to speed is slow.

## Rules
- Plain JavaScript (ES2020). No imports, no exports, no async, no network, no DOM, no Date, no timers.
  TRACK is a global: read it as TRACK (not state.TRACK).
- Global variables persist between calls, so you may keep memory between calls.
- Math.random is seeded (deterministic). Code must be under 20 KB.
- Each call has a strict CPU budget (about 100k operations). Exceeding it or throwing an error = your car stops and is out of the race.
- Your code is reused on many different tracks, so read TRACK at runtime and don't hardcode this track.
`.trim();
