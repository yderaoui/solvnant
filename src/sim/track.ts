// Procedural track generation: random points -> convex hull -> displaced midpoints
// -> centripetal Catmull-Rom -> uniform resample -> width/clearance/self-intersection checks.
// World units are meters. Screen-style coordinates: +x east, +y south (down).
// Heading 0 = +x, increasing heading turns clockwise on screen (= a right turn).
import { Rng } from './rng';
import { atan2, clamp, cos, sin, TAU, wrapAngle } from './dmath';

export type Vec = [number, number];

export interface Corner {
  id: number;
  start: number; // centerline index
  apex: number;
  end: number;
  direction: 'left' | 'right';
  radius: number; // m, at apex
  angle: number; // total turn, degrees (always positive)
  distance: number; // m from start line to apex
}

export interface Track {
  seed: string;
  points: Vec[]; // closed centerline, uniform spacing, index 0 = start/finish line
  widths: number[]; // full track width at each point, m
  headings: number[]; // direction of travel at each point, rad
  curvature: number[]; // signed 1/m, + = turning right
  spacing: number; // m between points
  length: number; // m
  corners: Corner[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export const TRACK_RULES = {
  minWidth: 12,
  maxWidth: 20,
  spacing: 8,
  minRadius: 16, // tightest allowed hairpin
  clearance: 14, // extra gap between non-adjacent parts of the track (runoff)
  minLength: 1300,
  maxLength: 3200,
};

const MAX_ATTEMPTS = 60;
const sq = (v: number) => v * v;

export function generateTrack(seed: string): Track {
  const rng = Rng.fromString('track:' + seed);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const t = tryGenerate(seed, rng);
    if (t) return t;
  }
  return ovalTrack(seed);
}

function tryGenerate(seed: string, rng: Rng): Track | null {
  const W = 760,
    H = 500;
  const n = rng.int(10, 20);
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) pts.push([rng.range(0, W), rng.range(0, H)]);
  const hull = convexHull(pts);
  if (hull.length < 4) return null;

  // Displace each hull edge's midpoint (mostly outward) to create corners.
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  let poly: Vec[] = [];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i],
      b = hull[(i + 1) % hull.length];
    poly.push(a);
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 60) continue;
    let nx = dy / len,
      ny = -dx / len;
    const mx = (a[0] + b[0]) / 2,
      my = (a[1] + b[1]) / 2;
    if (sq(mx + nx - cx) + sq(my + ny - cy) < sq(mx - cx) + sq(my - cy)) {
      nx = -nx;
      ny = -ny;
    }
    const amount = clamp(rng.range(-0.45, 0.6) * len * 0.5, -110, 130);
    const slide = rng.range(-0.15, 0.15) * len;
    poly.push([mx + nx * amount + (dx / len) * slide, my + ny * amount + (dy / len) * slide]);
  }

  // Push apart points that are too close.
  for (let iter = 0; iter < 6; iter++) {
    for (let i = 0; i < poly.length; i++) {
      for (let j = i + 1; j < poly.length; j++) {
        const dx = poly[j][0] - poly[i][0],
          dy = poly[j][1] - poly[i][1];
        const d = Math.sqrt(dx * dx + dy * dy);
        const min = 70;
        if (d < min && d > 1e-6) {
          const push = (min - d) / 2 / d;
          poly[i] = [poly[i][0] - dx * push, poly[i][1] - dy * push];
          poly[j] = [poly[j][0] + dx * push, poly[j][1] + dy * push];
        }
      }
    }
  }

  if (rng.next() < 0.5) poly = poly.reverse();

  const dense = catmullRomClosed(poly, 24);
  const { points, length, spacing } = resampleClosed(dense, TRACK_RULES.spacing);
  if (length < TRACK_RULES.minLength || length > TRACK_RULES.maxLength) return null;

  const N = points.length;
  const base = rng.range(13.5, 17.5);
  const a1 = rng.range(0.5, 2.5),
    a2 = rng.range(0.3, 1.5);
  const k1 = rng.int(1, 3),
    k2 = rng.int(3, 6);
  const p1 = rng.range(0, TAU),
    p2 = rng.range(0, TAU);
  const widths = points.map((_, i) =>
    clamp(base + a1 * sin((TAU * k1 * i) / N + p1) + a2 * sin((TAU * k2 * i) / N + p2), TRACK_RULES.minWidth, TRACK_RULES.maxWidth),
  );

  const { curvature } = computeGeometry(points, spacing);

  if (!validate(points, widths, curvature, spacing)) return null;

  const track = finalize(seed, points, widths, spacing, length);
  return track.corners.length >= 4 ? track : null;
}

function validate(points: Vec[], widths: number[], curvature: number[], spacing: number): boolean {
  const N = points.length;
  // Corners must be wide enough that the inside edge doesn't fold over itself.
  for (let i = 0; i < N; i++) {
    const r = 1 / Math.max(Math.abs(curvature[i]), 1e-9);
    if (r < Math.max(TRACK_RULES.minRadius, widths[i] / 2 + 6)) return false;
  }
  // Non-adjacent parts of the track must not touch (this also rules out self-intersections).
  const skip = Math.ceil(70 / spacing);
  for (let i = 0; i < N; i++) {
    for (let j = i + skip; j < N; j++) {
      if (N - (j - i) < skip) continue;
      const dx = points[i][0] - points[j][0],
        dy = points[i][1] - points[j][1];
      const need = (widths[i] + widths[j]) / 2 + TRACK_RULES.clearance;
      if (dx * dx + dy * dy < need * need) return false;
    }
  }
  return !selfIntersects(points);
}

function finalize(seed: string, pts: Vec[], ws: number[], spacing: number, length: number): Track {
  const N = pts.length;
  let { curvature } = computeGeometry(pts, spacing);
  // Start/finish goes in the middle of the longest straight.
  const straight = curvature.map((k) => Math.abs(k) < 1 / 250);
  let bestStart = 0,
    bestLen = -1;
  for (let i = 0; i < N; i++) {
    if (!straight[i] || straight[(i - 1 + N) % N]) continue;
    let len = 0;
    while (len < N && straight[(i + len) % N]) len++;
    if (len > bestLen) {
      bestLen = len;
      bestStart = i;
    }
  }
  const offset = bestLen > 0 ? (bestStart + Math.floor(bestLen * 0.6)) % N : 0;
  const points = rotate(pts, offset);
  const widths = rotate(ws, offset);
  const geo = computeGeometry(points, spacing);
  curvature = geo.curvature;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    seed,
    points: points.map(([x, y]) => [round2(x), round2(y)] as Vec),
    widths: widths.map(round2),
    headings: geo.headings.map((h) => Math.round(h * 10000) / 10000),
    curvature: curvature.map((k) => Math.round(k * 1e6) / 1e6),
    spacing,
    length,
    corners: findCorners(curvature, spacing),
    bounds: { minX, minY, maxX, maxY },
  };
}

function findCorners(curv: number[], spacing: number): Corner[] {
  const N = curv.length;
  const TH = 1 / 110;
  const inCorner = curv.map((k) => Math.abs(k) > TH);
  // Find a starting index that is not in a corner so groups don't wrap.
  let s0 = inCorner.findIndex((c) => !c);
  if (s0 < 0) return [];
  const groups: number[][] = [];
  let cur: number[] | null = null;
  for (let o = 0; o < N; o++) {
    const i = (s0 + o) % N;
    if (inCorner[i] && (!cur || Math.sign(curv[i]) === Math.sign(curv[cur[cur.length - 1]]))) {
      if (!cur) cur = [];
      cur.push(i);
    } else {
      if (cur) groups.push(cur);
      cur = inCorner[i] ? [i] : null;
    }
  }
  if (cur) groups.push(cur);

  const corners: Corner[] = [];
  for (const g of groups) {
    let total = 0,
      apex = g[0];
    for (const i of g) {
      total += curv[i] * spacing;
      if (Math.abs(curv[i]) > Math.abs(curv[apex])) apex = i;
    }
    const deg = (Math.abs(total) * 180) / Math.PI;
    if (deg < 25) continue;
    corners.push({
      id: 0,
      start: g[0],
      apex,
      end: g[g.length - 1],
      direction: total > 0 ? 'right' : 'left',
      radius: Math.round(1 / Math.abs(curv[apex])),
      angle: Math.round(deg),
      distance: Math.round(apex * spacing),
    });
  }
  corners.sort((a, b) => a.apex - b.apex);
  corners.forEach((c, i) => (c.id = i + 1));
  return corners;
}

export function computeGeometry(points: Vec[], spacing: number) {
  const N = points.length;
  const headings = points.map((_, i) => {
    const a = points[(i - 1 + N) % N],
      b = points[(i + 1) % N];
    return atan2(b[1] - a[1], b[0] - a[0]);
  });
  const raw = headings.map((_, i) => wrapAngle(headings[(i + 1) % N] - headings[(i - 1 + N) % N]) / (2 * spacing));
  // Light smoothing
  const curvature = raw.map((_, i) => (raw[(i - 1 + N) % N] + 2 * raw[i] + raw[(i + 1) % N]) / 4);
  return { headings, curvature };
}

function convexHull(points: Vec[]): Vec[] {
  const p = points.slice().sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const cross = (o: Vec, a: Vec, b: Vec) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec[] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: Vec[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Centripetal Catmull-Rom (alpha = 0.5): no cusps or self-loops within a segment. */
function catmullRomClosed(ctrl: Vec[], samplesPerSeg: number): Vec[] {
  const n = ctrl.length;
  const out: Vec[] = [];
  const knot = (a: Vec, b: Vec) => Math.sqrt(Math.sqrt(sq(b[0] - a[0]) + sq(b[1] - a[1]))) || 1e-4;
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n],
      p1 = ctrl[i],
      p2 = ctrl[(i + 1) % n],
      p3 = ctrl[(i + 2) % n];
    const t0 = 0,
      t1 = t0 + knot(p0, p1),
      t2 = t1 + knot(p1, p2),
      t3 = t2 + knot(p2, p3);
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = t1 + ((t2 - t1) * s) / samplesPerSeg;
      const pt: Vec = [0, 0];
      for (let d = 0; d < 2; d++) {
        const a1 = ((t1 - t) / (t1 - t0)) * p0[d] + ((t - t0) / (t1 - t0)) * p1[d];
        const a2 = ((t2 - t) / (t2 - t1)) * p1[d] + ((t - t1) / (t2 - t1)) * p2[d];
        const a3 = ((t3 - t) / (t3 - t2)) * p2[d] + ((t - t2) / (t3 - t2)) * p3[d];
        const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
        const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
        pt[d] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
      }
      out.push(pt);
    }
  }
  return out;
}

function resampleClosed(pts: Vec[], target: number) {
  const n = pts.length;
  const cum = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i],
      b = pts[(i + 1) % n];
    cum.push(cum[i] + Math.sqrt(sq(b[0] - a[0]) + sq(b[1] - a[1])));
  }
  const length = cum[n];
  const count = Math.max(8, Math.round(length / target));
  const spacing = length / count;
  const points: Vec[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const s = k * spacing;
    while (cum[seg + 1] < s) seg++;
    const a = pts[seg],
      b = pts[(seg + 1) % n];
    const f = (s - cum[seg]) / (cum[seg + 1] - cum[seg] || 1);
    points.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return { points, length, spacing };
}

function selfIntersects(pts: Vec[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i],
      b = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = pts[j],
        d = pts[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const o = (p: Vec, q: Vec, r: Vec) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a),
    d2 = o(c, d, b),
    d3 = o(a, b, c),
    d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function ovalTrack(seed: string): Track {
  const N = 260;
  const pts: Vec[] = [];
  for (let i = 0; i < N; i++) {
    const t = (TAU * i) / N;
    pts.push([380 + 330 * cos(t), 250 + 190 * sin(t)]);
  }
  const { points, length, spacing } = resampleClosed(pts, TRACK_RULES.spacing);
  return finalize(seed, points, points.map(() => 16), spacing, length);
}

function rotate<T>(arr: T[], k: number): T[] {
  return arr.slice(k).concat(arr.slice(0, k));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Number of laps so a race takes roughly two minutes at today's AI-driver pace (~15 m/s average). */
export function lapsFor(track: Track): number {
  const estLap = track.length / 15;
  return clamp(Math.round(120 / estLap), 1, 5);
}

/** Position, heading and half-width at arc length s (wraps). */
export function sampleTrack(track: Track, s: number) {
  const N = track.points.length;
  const L = track.length;
  s = ((s % L) + L) % L;
  const f = s / track.spacing;
  const i = Math.floor(f) % N;
  const j = (i + 1) % N;
  const t = f - Math.floor(f);
  const a = track.points[i],
    b = track.points[j];
  return {
    x: a[0] + (b[0] - a[0]) * t,
    y: a[1] + (b[1] - a[1]) * t,
    heading: atan2(b[1] - a[1], b[0] - a[0]),
    halfWidth: (track.widths[i] + (track.widths[j] - track.widths[i]) * t) / 2,
    index: i,
  };
}
