// Procedural night-time circuit dressing: grandstands with crowds, floodlights, trees, an
// infield (pond, paddock tents, helipad, big screen, fan zone), run-off line, sector markers,
// turn badges and a start/finish banner. Seeded from the track seed, so the same seed always
// gets the same venue. Purely visual: none of this affects the race simulation.
import { Container, Graphics, Text } from 'pixi.js';
import { Rng } from '../sim/rng';
import type { Track } from '../sim/track';

// RaceTrench night palette: dark woodland, floodlit asphalt, Solana purple accents.
export const SCENE_COLORS = {
  ground: 0x081a0e,
  groundPatch: 0x0c2314,
  verge: 0x123321,
  asphalt: 0x2b2f36,
  edge: 0xf2f5f8,
  runoff: 0x9945ff,
  stand: 0x1a2030,
  standRoof: 0x262d40,
  tree: 0x0e2c17,
  treeHi: 0x1a4a26,
  water: 0x0b2a3d,
  waterHi: 0x1b6a8e,
  light: 0xffe2a0,
  sector: [0x9945ff, 0x14f195, 0x22d3ee],
  red: 0xe3122d,
};

/** Text style for map badges (the renderer switches this to a pixel font in pixel mode). */
export const sceneryStyle = { font: '"Exo 2", Barlow, sans-serif', textRes: 2, fontSize: 12 };

const CROWD = [0xf5f5f5, 0xffd60a, 0xff3b3b, 0x3b82ff, 0x8cff2e, 0xff3dbb, 0xa259ff, 0xff8a1f, 0xd4d4d8, 0x22d3ee];

export interface Scenery {
  ground: Container; // under the track
  above: Container; // over the track surface (lights, badges)
  fixed: Container[]; // items to keep at constant screen size
  crowd: number[]; // x, y pairs where camera flashes may pop
  turns: number;
  clockwise: boolean;
}

export function buildScenery(track: Track): Scenery {
  const rng = Rng.fromString('scenery:' + track.seed);
  const N = track.points.length;
  const P = track.points;
  const hw = (i: number) => track.widths[((i % N) + N) % N] / 2;
  const nrm = (i: number): [number, number] => {
    const h = track.headings[((i % N) + N) % N];
    return [-Math.sin(h), Math.cos(h)]; // right-hand normal
  };
  const at = (i: number, off: number): [number, number] => {
    const k = ((i % N) + N) % N;
    const [nx, ny] = nrm(k);
    return [P[k][0] + nx * off, P[k][1] + ny * off];
  };
  const turning = track.curvature.reduce((s, k) => s + k, 0) * track.spacing;
  const clockwise = turning > 0;
  const inSide = clockwise ? 1 : -1; // infield is on the right when driving clockwise
  const outSide = -inSide;

  /** Distance from a point to the track edge (negative = on the track). */
  const clearance = (x: number, y: number) => {
    let best = Infinity;
    for (let i = 0; i < N; i++) {
      const dx = x - P[i][0],
        dy = y - P[i][1];
      const d = Math.sqrt(dx * dx + dy * dy) - hw(i);
      if (d < best) best = d;
    }
    return best;
  };
  const insideLoop = (x: number, y: number) => {
    let c = false;
    for (let i = 0, j = N - 1; i < N; j = i++) {
      const [xi, yi] = P[i],
        [xj, yj] = P[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  /** Offset line on one side that stops wherever it would fold inside a tight corner. */
  const offsetSegments = (side: number, off: (i: number) => number, from = 0, to = N) => {
    const segs: number[][] = [];
    let cur: number[] = [];
    for (let k = from; k <= to; k++) {
      const i = ((k % N) + N) % N;
      const kc = track.curvature[i];
      const o = off(i);
      const folds = kc * side > 0 && 1 / Math.abs(kc) < o + 4;
      if (folds) {
        if (cur.length > 2) segs.push(cur);
        cur = [];
        continue;
      }
      const [x, y] = at(i, side * o);
      cur.push(x, y);
    }
    if (cur.length > 2) segs.push(cur);
    return segs;
  };

  const ground = new Container();
  const above = new Container();
  const fixed: Container[] = [];
  const crowd: number[] = [];
  const occupied: Array<[number, number, number]> = []; // x, y, r
  const screens: number[] = [];
  let vipSpot: [number, number] | null = null;
  const free = (x: number, y: number, r: number) => occupied.every(([ox, oy, or]) => (x - ox) ** 2 + (y - oy) ** 2 > (r + or) ** 2);
  const b = track.bounds;

  // --- ground: dark grass with mottled patches
  const g = new Graphics();
  g.rect(b.minX - 3000, b.minY - 3000, b.maxX - b.minX + 6000, b.maxY - b.minY + 6000).fill(SCENE_COLORS.ground);
  for (let k = 0; k < 260; k++) {
    g.circle(rng.range(b.minX - 300, b.maxX + 300), rng.range(b.minY - 300, b.maxY + 300), rng.range(30, 110)).fill({
      color: SCENE_COLORS.groundPatch,
      alpha: 0.25,
    });
  }
  // Infield service road (follows the track inside, breaks where it would fold)
  for (const seg of offsetSegments(inSide, (i) => hw(i) + 34)) g.poly(seg, false).stroke({ width: 5, color: 0x161b19, alpha: 0.9 });
  ground.addChild(g);

  // --- grandstands with crowds: on long straights and outside big corners
  const stands = new Graphics();
  const people = new Graphics();
  const placeStand = (from: number, to: number, side: number, accent: number) => {
    const d0 = (i: number) => hw(i) + 9;
    const depth = 17;
    // Every point of the stand must stay clear of every part of the track.
    for (let k = from; k <= to; k += 2) {
      for (const extra of [0, depth]) {
        const [x, y] = at(k, side * (d0(k) + extra));
        if (clearance(x, y) < 7) return false;
      }
    }
    const inner: number[] = [],
      outer: number[] = [];
    for (let k = from; k <= to; k++) {
      inner.push(...at(k, side * d0(k)));
      outer.push(...at(k, side * (d0(k) + depth)));
    }
    const poly = [...inner];
    for (let k = outer.length - 2; k >= 0; k -= 2) poly.push(outer[k], outer[k + 1]);
    stands.poly(poly).fill(SCENE_COLORS.stand);
    stands.poly(inner, false).stroke({ width: 1.2, color: accent });
    stands.poly(outer, false).stroke({ width: 2.2, color: SCENE_COLORS.standRoof });
    // Audience: rows of coloured dots
    for (let row = 0; row < 6; row++) {
      const off = 2 + row * 2.3;
      for (let k = from; k < to; k++) {
        for (let s = 0; s < 6; s++) {
          if (rng.next() < 0.18) continue; // empty seats
          const t = s / 6;
          const [ax, ay] = at(k, side * (d0(k) + off));
          const [bx, by] = at(k + 1, side * (d0(k + 1) + off));
          const x = ax + (bx - ax) * t,
            y = ay + (by - ay) * t;
          people.circle(x, y, 0.75).fill(CROWD[Math.floor(rng.next() * CROWD.length)]);
          if (rng.next() < 0.08) crowd.push(x, y);
        }
      }
    }
    for (let k = from; k <= to; k += 3) {
      const [x, y] = at(k, side * (d0(k) + depth / 2));
      occupied.push([x, y, depth]);
    }
    return true;
  };
  // Straights
  const straight = track.curvature.map((k) => Math.abs(k) < 1 / 220);
  let standCount = 0;
  for (let i = 0; i < N && standCount < 5; ) {
    if (!straight[i]) {
      i++;
      continue;
    }
    let len = 0;
    while (len < N && straight[(i + len) % N]) len++;
    if (len >= 10) {
      const use = Math.min(len - 4, 20);
      const from = i + Math.floor((len - use) / 2);
      if (placeStand(from, from + use, outSide, standCount % 2 ? 0x2563eb : SCENE_COLORS.red) || placeStand(from, from + use, inSide, 0x2563eb))
        standCount++;
    }
    i += Math.max(len, 1);
  }
  // Outside of the biggest corners ("fans at the hairpin")
  const bigCorners = [...track.corners].sort((a, c) => c.angle - a.angle).slice(0, 3);
  for (const c of bigCorners) {
    const side = c.direction === 'right' ? -1 : 1;
    placeStand(c.apex - 5, c.apex + 5, side, SCENE_COLORS.red);
  }
  ground.addChild(stands, people);

  // --- infield features
  const features = new Graphics();
  const findSpot = (r: number, wantInside = true) => {
    for (let t = 0; t < 300; t++) {
      const x = rng.range(b.minX, b.maxX),
        y = rng.range(b.minY, b.maxY);
      if (insideLoop(x, y) !== wantInside) continue;
      if (clearance(x, y) < r + 14 || !free(x, y, r + 6)) continue;
      occupied.push([x, y, r]);
      return [x, y] as const;
    }
    return null;
  };
  // Pond with an island
  const pond = findSpot(55);
  if (pond) {
    const [px, py] = pond;
    for (let k = 0; k < 7; k++) {
      features.circle(px + rng.range(-24, 24), py + rng.range(-16, 16), rng.range(22, 34)).fill(SCENE_COLORS.water);
    }
    features.circle(px - 10, py - 8, 16).fill({ color: SCENE_COLORS.waterHi, alpha: 0.45 });
    features.circle(px + 6, py + 4, 7).fill(SCENE_COLORS.tree).circle(px + 5, py + 3, 4.5).fill(SCENE_COLORS.treeHi);
  }
  // Paddocks: grids of tents and trucks, each with a big screen
  for (let pk = 0; pk < 2; pk++) {
  const paddock = findSpot(pk === 0 ? 60 : 45);
  if (paddock) {
    const [cx, cy] = paddock;
    const ang = rng.range(0, Math.PI);
    const ca = Math.cos(ang),
      sa = Math.sin(ang);
    const span = pk === 0 ? 2 : 1;
    // paved apron under the tents
    features.poly(rect(cx, cy, (span * 2 + 1) * 19 + 8, 3 * 20 + 6, ang)).fill({ color: 0x1b201f, alpha: 0.9 });
    for (let gx = -span; gx <= span; gx++) {
      for (let gy = -1; gy <= 1; gy++) {
        if (rng.next() < 0.15) continue;
        const lx = gx * 19,
          ly = gy * 20;
        const x = cx + lx * ca - ly * sa,
          y = cy + lx * sa + ly * ca;
        const big = rng.next() < 0.3;
        const w = big ? 16 : 11;
        const col = rng.next() < 0.75 ? 0xe9ecef : rng.next() < 0.5 ? SCENE_COLORS.red : 0xf0b429;
        features.poly(rect(x, y, w, w * 0.8, ang)).fill(col);
        features.poly(rect(x, y, w, 0.5, ang)).fill({ color: 0x000000, alpha: 0.25 }); // ridge
      }
    }
    // a big screen next to the paddock
    const sx = cx - sa * 46,
      sy = cy + ca * 46;
    features.poly(rect(sx, sy, 44, 7, ang)).fill(0x0d0f14);
    features.poly(rect(sx, sy, 41, 4.5, ang)).fill(pk === 0 ? 0x3b82f6 : SCENE_COLORS.red);
    screens.push(sx, sy);
    occupied.push([sx, sy, 24]);
  }
  }
  // Helipad
  const heli = findSpot(22);
  if (heli) {
    const [hx, hy] = heli;
    features.circle(hx, hy, 18).fill(0x13241b).circle(hx, hy, 18).stroke({ width: 1.2, color: 0xe5e7eb, alpha: 0.8 });
    features.rect(hx - 6.5, hy - 8, 2, 16).fill(0xe5e7eb).rect(hx + 4.5, hy - 8, 2, 16).fill(0xe5e7eb).rect(hx - 6.5, hy - 1, 13, 2).fill(0xe5e7eb);
  }
  // VIP stand in the infield, facing the nearest track
  const vip = findSpot(26);
  if (vip) {
    const [vx, vy] = vip;
    let ni = 0,
      nd = Infinity;
    for (let i = 0; i < N; i++) {
      const d = (P[i][0] - vx) ** 2 + (P[i][1] - vy) ** 2;
      if (d < nd) (nd = d), (ni = i);
    }
    const ang = Math.atan2(P[ni][1] - vy, P[ni][0] - vx) + Math.PI / 2;
    features.poly(rect(vx, vy, 40, 16, ang)).fill(SCENE_COLORS.stand);
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 22; c++) {
        if (rng.next() < 0.2) continue;
        const lx = -19 + c * 1.8,
          ly = -6 + r * 2.6;
        const x = vx + lx * Math.cos(ang) - ly * Math.sin(ang),
          y = vy + lx * Math.sin(ang) + ly * Math.cos(ang);
        features.circle(x, y, 0.75).fill(CROWD[Math.floor(rng.next() * CROWD.length)]);
        if (rng.next() < 0.05) crowd.push(x, y);
      }
    features.poly(rect(vx - Math.sin(ang) * 10, vy + Math.cos(ang) * 10, 30, 4, ang)).fill(0x0d0f14);
    vipSpot = [vx - Math.sin(ang) * 10, vy + Math.cos(ang) * 10];
  }
  // Fan zone: striped umbrellas
  const fan = findSpot(32);
  if (fan) {
    const [fx, fy] = fan;
    features.circle(fx, fy, 30).fill({ color: 0x1a1f1c, alpha: 0.85 });
    for (let k = 0; k < 22; k++) {
      const a = rng.range(0, Math.PI * 2),
        r = rng.range(0, 25);
      const x = fx + Math.cos(a) * r,
        y = fy + Math.sin(a) * r;
      features.circle(x, y, 3.4).fill(SCENE_COLORS.red).circle(x, y, 1.7).fill(0xffffff);
    }
  }
  ground.addChild(features);

  // --- trees: clustered, never on the track or other features
  const trees = new Graphics();
  // Grow trees around random cluster centres so they read as woods, not confetti.
  for (let cl = 0; cl < 90; cl++) {
    const cx = rng.range(b.minX - 180, b.maxX + 180),
      cy = rng.range(b.minY - 180, b.maxY + 180);
    const spread = rng.range(15, 45);
    for (let t = 0; t < 28; t++) {
      const x = cx + rng.range(-spread, spread),
        y = cy + rng.range(-spread, spread);
      const r = rng.range(3.5, 7.5);
      if (clearance(x, y) < r + 11 || !free(x, y, r + 1)) continue;
      trees.circle(x + 1.2, y + 1.6, r).fill({ color: 0x000000, alpha: 0.35 }); // shadow
      trees.circle(x, y, r).fill(SCENE_COLORS.tree);
      trees.circle(x - r * 0.25, y - r * 0.25, r * 0.6).fill({ color: SCENE_COLORS.treeHi, alpha: 0.85 });
    }
  }
  ground.addChild(trees);

  // --- run-off line (yellow) on the outside of the loop
  const runoff = new Graphics();
  for (const seg of offsetSegments(outSide, (i) => hw(i) + 3.5)) runoff.poly(seg, false).stroke({ width: 0.5, color: SCENE_COLORS.runoff, alpha: 0.8 });
  for (const seg of offsetSegments(inSide, (i) => hw(i) + 3.5)) runoff.poly(seg, false).stroke({ width: 0.4, color: SCENE_COLORS.runoff, alpha: 0.45 });
  ground.addChild(runoff);

  // --- floodlights (additive glow), every ~55 m on the outside
  const lights = new Graphics();
  lights.blendMode = 'add';
  for (let i = 0; i < N; i += 7) {
    const side = rng.next() < 0.7 ? outSide : inSide;
    const [x, y] = at(i, side * (hw(i) + 6.5));
    if (clearance(x, y) < 4) continue;
    glow(lights, x, y, 18, SCENE_COLORS.light, 0.2);
    lights.circle(x, y, 1.4).fill({ color: 0xfff3c4, alpha: 1 });
  }
  for (let k = 0; k < screens.length; k += 2) glow(lights, screens[k], screens[k + 1], 34, 0x5b8cff, 0.22);
  if (vipSpot) glow(lights, vipSpot[0], vipSpot[1], 24, SCENE_COLORS.light, 0.18);
  above.addChild(lights);

  // --- sector markers
  const sectors = new Graphics();
  for (let s = 0; s < 3; s++) {
    const a = Math.floor((s * N) / 3),
      e = Math.floor(((s + 1) * N) / 3);
    const from = a + Math.floor((e - a) * 0.3),
      to = a + Math.floor((e - a) * 0.7);
    for (const seg of offsetSegments(outSide, (i) => hw(i) + 8, from, to))
      sectors.poly(seg, false).stroke({ width: 1.4, color: SCENE_COLORS.sector[s], alpha: 0.95 });
    // Badge at the sector point farthest from any corner, so it never collides with a turn badge.
    let mid = Math.floor((a + e) / 2),
      bestGap = -1;
    for (let k = a + 2; k < e - 2; k++) {
      const gap = Math.min(...[0, ...track.corners.map((c) => c.apex)].map((ap) => Math.min(Math.abs(ap - k), N - Math.abs(ap - k))));
      if (gap > bestGap) (bestGap = gap), (mid = k);
    }
    const [x, y] = at(mid, outSide * (hw(mid) + 15));
    fixed.push(badge(above, `S${s + 1}`, x, y, SCENE_COLORS.sector[s]));
  }
  above.addChildAt(sectors, 0);

  // --- turn badges
  for (const c of track.corners) {
    const side = c.direction === 'right' ? -1 : 1;
    const [x, y] = at(c.apex, side * (hw(c.apex) + 14));
    fixed.push(badge(above, `T${c.id}`, x, y, SCENE_COLORS.red));
  }

  // --- start/finish banner + direction arrow
  const [bx, by] = at(0, outSide * (hw(0) + 11));
  fixed.push(badge(above, 'START / FINISH', bx, by, SCENE_COLORS.red, true));
  const arrow = new Graphics();
  const h0 = track.headings[3 % N];
  const [ax, ay] = at(3, 0);
  const fx = Math.cos(h0),
    fy = Math.sin(h0),
    rx = -fy,
    ry = fx;
  arrow
    .poly([ax + fx * 4, ay + fy * 4, ax - fx * 2 + rx * 3, ay - fy * 2 + ry * 3, ax - fx * 0.5, ay - fy * 0.5, ax - fx * 2 - rx * 3, ay - fy * 2 - ry * 3])
    .fill({ color: 0xffffff, alpha: 0.75 });
  above.addChild(arrow);

  return { ground, above, fixed, crowd, turns: track.corners.length, clockwise };
}

/** Soft radial glow: stacked translucent discs give a smooth falloff instead of a hard edge. */
function glow(g: Graphics, x: number, y: number, r: number, color: number, strength: number) {
  const steps = 6;
  for (let i = steps; i >= 1; i--) g.circle(x, y, (r * i) / steps).fill({ color, alpha: strength / steps });
}

function badge(parent: Container, text: string, x: number, y: number, border: number, filled = false): Container {
  const c = new Container();
  const t = new Text({
    text,
    style: { fontFamily: sceneryStyle.font, fontSize: sceneryStyle.fontSize, fontStyle: 'italic', fontWeight: '800', fill: 0xffffff, letterSpacing: 0.5 },
    resolution: sceneryStyle.textRes,
  });
  t.anchor.set(0.5);
  const w = t.width + 16,
    h = Math.max(20, t.height + 6);
  const g = new Graphics()
    .roundRect(-w / 2, -h / 2, w, h, 4)
    .fill({ color: filled ? border : 0x06090c, alpha: filled ? 0.95 : 0.9 })
    .roundRect(-w / 2, -h / 2, w, h, 4)
    .stroke({ width: 1.5, color: border });
  c.addChild(g, t);
  c.position.set(x, y);
  parent.addChild(c);
  return c;
}

function rect(cx: number, cy: number, w: number, h: number, ang: number): number[] {
  const c = Math.cos(ang),
    s = Math.sin(ang);
  const pts: number[] = [];
  for (const [lx, ly] of [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ]) {
    pts.push(cx + lx * c - ly * s, cy + lx * s + ly * c);
  }
  return pts;
}
