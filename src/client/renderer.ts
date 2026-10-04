// PixiJS renderer: track, cars, labels, tire smoke and a broadcast camera.
import { Application, Circle, Container, Graphics, Text } from 'pixi.js';
import type { Track } from '../sim/track';
import { FLAG } from '../sim/race';

export interface CarVisual {
  x: number;
  y: number;
  h: number;
  speed: number;
  slip: number;
  flags: number;
}

export type CameraMode = 'overview' | 'leader' | 'car';

interface CarSprite {
  root: Container;
  body: Container;
  brake: Graphics;
  label: Text;
  ring: Graphics;
}

interface Particle {
  x: number;
  y: number;
  life: number;
  max: number;
  size: number;
  color: number;
}

const COLORS = {
  grass: 0x14261a,
  verge: 0x1d3524,
  asphalt: 0x353a43,
  line: 0xe9edf2,
  kerbRed: 0xd8262c,
  kerbWhite: 0xf1f1f1,
};

export class RaceRenderer {
  app!: Application;
  private world = new Container();
  private trackLayer = new Container();
  private fx = new Graphics();
  private carLayer = new Container();
  private labelLayer = new Container();
  private scaleFixed: Container[] = []; // labels kept at constant screen size
  private cars: CarSprite[] = [];
  private particles: Particle[] = [];
  private track: Track | null = null;
  private zoom = 1;
  private camX = 0;
  private camY = 0;
  private snap = true;
  mode: CameraMode = 'overview';
  focus = 0;
  selected = -1;
  onCarClick: (car: number) => void = () => {};

  static async create(el: HTMLElement): Promise<RaceRenderer> {
    const r = new RaceRenderer();
    r.app = new Application();
    await r.app.init({
      resizeTo: el,
      background: COLORS.grass,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    el.appendChild(r.app.canvas);
    new ResizeObserver(() => r.app.resize()).observe(el);
    r.world.addChild(r.trackLayer, r.fx, r.carLayer, r.labelLayer);
    r.app.stage.addChild(r.world);
    r.app.stage.eventMode = 'static';
    return r;
  }

  setTrack(track: Track) {
    this.track = track;
    this.trackLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.scaleFixed = this.scaleFixed.filter((c) => !c.destroyed);
    this.particles = [];
    const N = track.points.length;
    const normal = (i: number): [number, number] => [-Math.sin(track.headings[i]), Math.cos(track.headings[i])];
    const edge = (off: (i: number) => number) =>
      track.points.flatMap((p, i) => {
        const [nx, ny] = normal(i);
        const o = off(i);
        return [p[0] + nx * o, p[1] + ny * o];
      });
    const ring = (inner: number[], outer: number[], color: number) => {
      const g = new Graphics();
      const [a, b] = Math.abs(area(inner)) > Math.abs(area(outer)) ? [inner, outer] : [outer, inner];
      g.poly(a).fill(color).poly(b).cut();
      return g;
    };
    const b = track.bounds;
    const bg = new Graphics().rect(b.minX - 2000, b.minY - 2000, b.maxX - b.minX + 4000, b.maxY - b.minY + 4000).fill(COLORS.grass);
    this.trackLayer.addChild(bg);
    this.trackLayer.addChild(ring(edge((i) => -track.widths[i] / 2 - 5), edge((i) => track.widths[i] / 2 + 5), COLORS.verge));
    this.trackLayer.addChild(ring(edge((i) => -track.widths[i] / 2), edge((i) => track.widths[i] / 2), COLORS.asphalt));

    const lines = new Graphics();
    for (const side of [-1, 1]) {
      const e = edge((i) => side * (track.widths[i] / 2 - 0.5));
      lines.poly(e, true).stroke({ width: 0.35, color: COLORS.line, alpha: 0.85 });
    }
    this.trackLayer.addChild(lines);

    // Kerbs on both edges through each corner.
    const kerbs = new Graphics();
    for (const c of track.corners) {
      let i = (c.start - 2 + N) % N;
      const end = (c.end + 2) % N;
      let k = 0;
      while (i !== end) {
        const j = (i + 1) % N;
        for (const side of [-1, 1]) {
          for (let half = 0; half < 2; half++) {
            const t0 = half / 2,
              t1 = (half + 1) / 2;
            const pa = lerpPt(track, i, j, t0),
              pb = lerpPt(track, i, j, t1);
            const [nx, ny] = normal(i);
            const w = track.widths[i] / 2;
            const o1 = side * (w - 1.1),
              o2 = side * (w + 0.3);
            kerbs
              .poly([pa[0] + nx * o1, pa[1] + ny * o1, pb[0] + nx * o1, pb[1] + ny * o1, pb[0] + nx * o2, pb[1] + ny * o2, pa[0] + nx * o2, pa[1] + ny * o2])
              .fill((k + half) % 2 === 0 ? COLORS.kerbRed : COLORS.kerbWhite);
          }
        }
        k++;
        i = j;
      }
    }
    this.trackLayer.addChild(kerbs);

    // Start/finish line (checkered) and grid boxes.
    const sf = new Graphics();
    const [nx, ny] = normal(0);
    const hw = track.widths[0] / 2;
    const fx = Math.cos(track.headings[0]),
      fy = Math.sin(track.headings[0]);
    const sq = 1.2;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < Math.floor((hw * 2) / sq); c++) {
        const lat = -hw + c * sq;
        const lon = r * sq;
        const x = track.points[0][0] + nx * lat + fx * lon,
          y = track.points[0][1] + ny * lat + fy * lon;
        sf.poly([x, y, x + nx * sq, y + ny * sq, x + nx * sq + fx * sq, y + ny * sq + fy * sq, x + fx * sq, y + fy * sq]).fill(
          (r + c) % 2 ? 0x111111 : 0xffffff,
        );
      }
    }
    this.trackLayer.addChild(sf);

    // Corner numbers
    for (const c of track.corners) {
      const [cx, cy] = normal(c.apex);
      const side = c.direction === 'right' ? -1 : 1;
      const off = (track.widths[c.apex] / 2 + 12) * side;
      const t = new Text({
        text: `T${c.id}`,
        style: { fontFamily: 'Titillium Web, sans-serif', fontSize: 13, fontWeight: '700', fill: 0xc8d0dc },
        resolution: 2,
      });
      t.anchor.set(0.5);
      t.alpha = 0.7;
      t.position.set(track.points[c.apex][0] + cx * off, track.points[c.apex][1] + cy * off);
      this.trackLayer.addChild(t);
      this.scaleFixed.push(t);
    }
    this.snap = true;
  }

  setCars(entries: { name: string; color: string }[]) {
    for (const c of this.cars) {
      c.root.destroy({ children: true });
      c.label.destroy();
    }
    this.cars = entries.map((e, i) => {
      const color = parseInt(e.color.slice(1), 16);
      const root = new Container();
      const ring = new Graphics().circle(0, 0, 4.2).stroke({ width: 0.5, color: 0xffffff, alpha: 0.9 });
      ring.visible = false;
      const body = new Container();
      const g = new Graphics();
      g.roundRect(-2.3, -1, 4.6, 2, 0.55).fill(color);
      g.rect(1.9, -1.1, 0.5, 2.2).fill(0xf5f5f5); // front wing
      g.rect(-2.45, -1.05, 0.45, 2.1).fill(0x222222); // rear wing
      g.roundRect(-0.6, -0.5, 1.5, 1.0, 0.35).fill(0x111318); // cockpit
      g.rect(-1.8, -0.15, 3.6, 0.3).fill({ color: 0xffffff, alpha: 0.25 }); // stripe
      const brake = new Graphics().rect(-2.55, -0.9, 0.25, 0.5).rect(-2.55, 0.4, 0.25, 0.5).fill(0xff2020);
      brake.visible = false;
      body.addChild(g, brake);
      root.addChild(ring, body);
      root.eventMode = 'static';
      root.cursor = 'pointer';
      root.hitArea = new Circle(0, 0, 6);
      root.on('pointertap', () => this.onCarClick(i));
      this.carLayer.addChild(root);

      const label = new Text({
        text: e.name,
        style: {
          fontFamily: 'Titillium Web, sans-serif',
          fontSize: 12,
          fontWeight: '700',
          fill: 0xffffff,
          stroke: { color: 0x000000, width: 3 },
        },
        resolution: 2,
      });
      label.anchor.set(0.5, 1);
      label.eventMode = 'static';
      label.cursor = 'pointer';
      label.on('pointertap', () => this.onCarClick(i));
      this.labelLayer.addChild(label);
      root.visible = label.visible = false; // shown once there's a frame to draw
      this.scaleFixed.push(label);
      return { root, body, brake, label, ring };
    });
  }

  /** Draw one frame. `leader` is used by the leader camera; `dt` is wall-clock seconds. */
  render(cars: CarVisual[], leader: number, dt: number, animateFx: boolean) {
    if (!this.track) return;
    const W = this.app.screen.width,
      H = this.app.screen.height;
    const b = this.track.bounds;
    const fitZoom = Math.min(W / (b.maxX - b.minX + 90), H / (b.maxY - b.minY + 90));
    let tz = fitZoom,
      tx = (b.minX + b.maxX) / 2,
      ty = (b.minY + b.maxY) / 2;
    const followIdx = this.mode === 'leader' ? leader : this.mode === 'car' ? this.focus : -1;
    if (followIdx >= 0 && cars[followIdx]) {
      tz = Math.max(fitZoom * 3, Math.min(6, Math.max(W, H) / 240));
      const c = cars[followIdx];
      tx = c.x + Math.cos(c.h) * c.speed * 0.6;
      ty = c.y + Math.sin(c.h) * c.speed * 0.6;
    }
    const k = this.snap ? 1 : Math.min(1, dt * 3);
    this.zoom += (tz - this.zoom) * k;
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;
    this.snap = false;
    this.world.scale.set(this.zoom);
    this.world.position.set(W / 2 - this.camX * this.zoom, H / 2 - this.camY * this.zoom);

    const carScale = Math.max(1, Math.min(2.4, 2.6 / this.zoom));
    for (const t of this.scaleFixed) if (!t.destroyed) t.scale.set(1 / this.zoom);
    cars.forEach((c, i) => {
      const s = this.cars[i];
      if (!s) return;
      s.root.visible = s.label.visible = true;
      s.root.position.set(c.x, c.y);
      s.body.rotation = c.h;
      s.root.scale.set(carScale);
      s.brake.visible = (c.flags & FLAG.braking) !== 0;
      s.root.alpha = c.flags & FLAG.stopped && !(c.flags & FLAG.finished) ? 0.45 : 1;
      s.ring.visible = i === this.selected;
      s.label.position.set(c.x, c.y - 3.2 * carScale);
      if (animateFx) {
        if (c.slip > 2.2 && c.speed > 5 && Math.random() < 0.6) this.puff(c, 0xb9bec7, 1 + c.slip * 0.15);
        if (c.flags & FLAG.offTrack && c.speed > 8 && Math.random() < 0.5) this.puff(c, 0x8b7350, 1.6);
      }
    });

    // Particles
    this.fx.clear();
    for (const p of this.particles) {
      p.life -= dt;
      const a = Math.max(0, p.life / p.max);
      this.fx.circle(p.x, p.y, p.size * (2 - a)).fill({ color: p.color, alpha: a * 0.35 });
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  resetCamera() {
    this.snap = true;
  }

  private puff(c: CarVisual, color: number, size: number) {
    if (this.particles.length > 400) return;
    this.particles.push({
      x: c.x - Math.cos(c.h) * 2 + (Math.random() - 0.5),
      y: c.y - Math.sin(c.h) * 2 + (Math.random() - 0.5),
      life: 0.9,
      max: 0.9,
      size,
      color,
    });
  }
}

function area(flat: number[]): number {
  let a = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const j = (i + 2) % flat.length;
    a += flat[i] * flat[j + 1] - flat[j] * flat[i + 1];
  }
  return a / 2;
}

function lerpPt(track: Track, i: number, j: number, t: number): [number, number] {
  const a = track.points[i],
    b = track.points[j];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
