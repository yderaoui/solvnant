// Things you can crash into besides the wall: trees in the run-off and catch fences in front of the
// standing crowd. Generated from the track seed (same seed -> same obstacles everywhere) and resolved
// inside the deterministic sim, so a crash happens identically on the server, in replays and in
// every browser. Only +, -, *, /, sqrt and dmath trig are used.
import { clamp, cos, sin } from './dmath';
import { Rng } from './rng';
import { PHYS, type Car } from './physics';
import type { Track } from './track';

export interface Tree {
  x: number;
  y: number;
  r: number; // trunk collision radius, m
  size: number; // visual scale
  kind: 0 | 1; // 0 = broadleaf, 1 = pine (visual only)
}

export interface Fence {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Which side of the fence the crowd stands on: unit normal pointing at the spectators. */
  nx: number;
  ny: number;
}

export interface Obstacles {
  trees: Tree[];
  fences: Fence[];
  /** Spectator areas behind the fences: polyline of [x, y] points + normal towards the crowd. */
  crowdZones: { pts: [number, number][]; nx: number[]; ny: number[] }[];
  /** Trees knocked flat (they stop colliding). Mutated by collisions. */
  down: boolean[];
}

export interface ObstacleHit {
  kind: 'tree' | 'treedown' | 'fence';
  index: number;
  impact: number; // m/s into the obstacle
  x: number;
  y: number;
}

export const OBSTACLE_RULES = {
  treeBreak: 16, // m/s: hit a tree faster than this and it snaps
  fenceOffset: 11, // m beyond the track edge
  treeMinOffset: 8,
  treeMaxOffset: 22,
};

export function generateObstacles(track: Track): Obstacles {
  const rng = Rng.fromString(`obstacles:${track.seed}`);
  const P = track.points,
    W = track.widths,
    H = track.headings;
  const N = P.length;
  const at = (i: number, o: number): [number, number] => [P[i][0] - sin(H[i]) * o, P[i][1] + cos(H[i]) * o];
  /** True if (x, y) keeps at least `margin` m from the edge of every part of the track. */
  const clear = (x: number, y: number, margin: number) => {
    for (let j = 0; j < N; j++) {
      const dx = P[j][0] - x,
        dy = P[j][1] - y;
      const m = W[j] / 2 + margin;
      if (dx * dx + dy * dy < m * m) return false;
    }
    return true;
  };
  let cx = 0,
    cy = 0;
  for (const p of P) {
    cx += p[0];
    cy += p[1];
  }
  cx /= N;
  cy /= N;
  const outside = (i: number) => {
    const nx = -sin(H[i]),
      ny = cos(H[i]);
    return (P[i][0] - cx) * nx + (P[i][1] - cy) * ny > 0 ? 1 : -1;
  };

  // Crowd fences along the two longest straights, on the outside of the circuit.
  const runs: { a: number; n: number }[] = [];
  for (let i = 0, run = 0; i < N * 2; i++) {
    const j = i % N;
    if (Math.abs(track.curvature[j]) < 1 / 300) run++;
    else {
      if (run >= 12 && i - run < N) runs.push({ a: (i - run) % N, n: run });
      run = 0;
    }
  }
  runs.sort((a, b) => b.n - a.n || a.a - b.a);
  const fences: Fence[] = [];
  const crowdZones: Obstacles['crowdZones'] = [];
  const fenceIdx = new Set<number>();
  for (const run of runs.slice(0, 2)) {
    const zone = { pts: [] as [number, number][], nx: [] as number[], ny: [] as number[] };
    let prev: [number, number] | null = null;
    for (let k = 2; k < run.n - 2; k++) {
      const i = (run.a + k) % N;
      const s = outside(i);
      const o = s * (W[i] / 2 + OBSTACLE_RULES.fenceOffset);
      const p = at(i, o);
      if (!clear(p[0], p[1], OBSTACLE_RULES.fenceOffset - 2)) {
        prev = null;
        continue;
      }
      const nx = -sin(H[i]) * s,
        ny = cos(H[i]) * s;
      if (prev) fences.push({ ax: prev[0], ay: prev[1], bx: p[0], by: p[1], nx, ny });
      prev = p;
      zone.pts.push(p);
      zone.nx.push(nx);
      zone.ny.push(ny);
      fenceIdx.add(i);
    }
    if (zone.pts.length > 3) crowdZones.push(zone);
  }

  // Tree clusters in the run-off, more on the outside of corners (where cars run wide).
  const trees: Tree[] = [];
  const step = 6; // centerline points between candidate clusters (~48 m)
  for (let i = 0; i < N; i += step) {
    const near = (j: number) => fenceIdx.has((i + j + N) % N);
    if (near(0) || near(3) || near(-3) || near(6) || near(-6)) continue;
    const k = track.curvature[i];
    const outerSide = k > 0 ? -1 : 1; // + curvature turns right, so the outside is the left
    const sides = Math.abs(k) > 1 / 150 ? [outerSide] : rng.next() < 0.5 ? [-1] : [1];
    for (const s of sides) {
      if (rng.next() < 0.25) continue;
      const count = 1 + Math.floor(rng.next() * 3);
      for (let t = 0; t < count; t++) {
        const o = s * (W[i] / 2 + OBSTACLE_RULES.treeMinOffset + rng.next() * (OBSTACLE_RULES.treeMaxOffset - OBSTACLE_RULES.treeMinOffset));
        const along = (rng.next() - 0.5) * 14;
        const base = at(i, o);
        const x = base[0] + cos(H[i]) * along,
          y = base[1] + sin(H[i]) * along;
        if (!clear(x, y, OBSTACLE_RULES.treeMinOffset - 1)) continue;
        if (trees.some((q) => (q.x - x) * (q.x - x) + (q.y - y) * (q.y - y) < 36)) continue;
        const size = 0.8 + rng.next() * 0.6;
        trees.push({ x, y, r: 0.45 + 0.35 * size, size, kind: rng.next() < 0.4 ? 1 : 0 });
      }
    }
  }
  return { trees, fences, crowdZones, down: trees.map(() => false) };
}

/** Resolve one car against trees and fences. Returns the hardest hit this step, if any. */
export function collideObstacles(car: Car, ob: Obstacles): ObstacleHit | null {
  const fx = cos(car.h),
    fy = sin(car.h);
  const R = PHYS.circleRadius;
  let hit: ObstacleHit | null = null;
  const report = (h: ObstacleHit) => {
    if (!hit || h.impact > hit.impact) hit = h;
  };
  for (let k = -1; k <= 1; k += 2) {
    const ccx = car.x + fx * PHYS.circleOffset * k,
      ccy = car.y + fy * PHYS.circleOffset * k;
    // Trees
    for (let j = 0; j < ob.trees.length; j++) {
      if (ob.down[j]) continue;
      const t = ob.trees[j];
      const dx = ccx - t.x;
      if (dx > 4 || dx < -4) continue;
      const dy = ccy - t.y;
      if (dy > 4 || dy < -4) continue;
      const min = R + t.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 1e-6;
      const nx = dx / d,
        ny = dy / d;
      car.x += nx * (min - d);
      car.y += ny * (min - d);
      const vn = car.vx * nx + car.vy * ny;
      if (vn >= 0) continue;
      const impact = -vn;
      if (impact > OBSTACLE_RULES.treeBreak) {
        // Snaps the tree: the car ploughs through but loses a lot of speed.
        ob.down[j] = true;
        car.vx *= 0.5;
        car.vy *= 0.5;
        report({ kind: 'treedown', index: j, impact, x: t.x, y: t.y });
      } else {
        car.vx -= 1.35 * vn * nx;
        car.vy -= 1.35 * vn * ny;
        car.vx *= 0.7;
        car.vy *= 0.7;
        car.h += clamp((fx * ny - fy * nx) * impact * 0.03 * k, -0.6, 0.6); // glancing hits spin the car
        if (impact > 2) report({ kind: 'tree', index: j, impact, x: t.x, y: t.y });
      }
    }
    // Fences (segments)
    for (let j = 0; j < ob.fences.length; j++) {
      const f = ob.fences[j];
      const minX = f.ax < f.bx ? f.ax : f.bx,
        maxX = f.ax < f.bx ? f.bx : f.ax;
      const minY = f.ay < f.by ? f.ay : f.by,
        maxY = f.ay < f.by ? f.by : f.ay;
      if (ccx < minX - 2 || ccx > maxX + 2 || ccy < minY - 2 || ccy > maxY + 2) continue;
      const ex = f.bx - f.ax,
        ey = f.by - f.ay;
      const len2 = ex * ex + ey * ey || 1e-6;
      const u = clamp(((ccx - f.ax) * ex + (ccy - f.ay) * ey) / len2, 0, 1);
      const px = f.ax + ex * u,
        py = f.ay + ey * u;
      const dx = ccx - px,
        dy = ccy - py;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R) continue;
      const d = Math.sqrt(d2) || 1e-6;
      // Normal pointing back towards the track side the car came from.
      let nx = dx / d,
        ny = dy / d;
      if (d2 < 1e-6) {
        nx = -f.nx;
        ny = -f.ny;
      }
      car.x += nx * (R - d);
      car.y += ny * (R - d);
      const vn = car.vx * nx + car.vy * ny;
      if (vn >= 0) continue;
      car.vx -= 1.4 * vn * nx;
      car.vy -= 1.4 * vn * ny;
      car.vx *= 0.8;
      car.vy *= 0.8;
      if (-vn > 2) report({ kind: 'fence', index: j, impact: -vn, x: px, y: py });
    }
  }
  return hit;
}
