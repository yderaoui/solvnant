// 3D chase camera: the same race (same physics, same track) drawn in 3D from behind a car.
// Sim coordinates map straight onto the ground plane: sim (x, y) -> three (x, 0, y), heading h -> rotation.y = -h.
// Loaded on demand (dynamic import) so the 2D pages never download three.js.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Track } from '../sim/track';
import { PHYS } from '../sim/physics';
import { FLAG } from '../sim/race';
import { Rng } from '../sim/rng';
import type { CarVisual } from './renderer';

const NEON = 0x8cff2e;
const WALL_OFFSET = PHYS.runoff; // the physical wall sits this far beyond the track edge

type P3 = [number, number, number];

interface CarModel {
  group: THREE.Group;
  tail: THREE.MeshBasicMaterial;
  label: THREE.Sprite | null;
}

export class Chase3D {
  readonly canvas: HTMLCanvasElement;
  private gl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, 1, 0.5, 2600);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private world = new THREE.Group();
  private carGroup = new THREE.Group();
  private cars: CarModel[] = [];
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private snap = true;
  private shared = sharedCarParts();

  constructor(private host: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.15;
    this.canvas = this.gl.domElement;
    this.canvas.className = 'chase3d';
    this.canvas.style.display = 'none';
    host.appendChild(this.canvas);

    this.scene.background = skyTexture();
    this.scene.fog = new THREE.Fog(0x0a1426, 160, 1100);
    this.scene.add(new THREE.HemisphereLight(0x7d93c8, 0x0c1f12, 1.1));
    const moon = new THREE.DirectionalLight(0xc8d8ff, 1.0);
    moon.position.set(-300, 500, -200);
    this.scene.add(moon, this.world, this.carGroup);

    this.composer = new EffectComposer(this.gl);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.45, 0.72);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  get visible() {
    return this.canvas.style.display !== 'none';
  }

  setVisible(v: boolean) {
    if (v === this.visible) return;
    this.canvas.style.display = v ? 'block' : 'none';
    this.snap = true;
    if (v) this.resize();
  }

  private resize() {
    const w = this.host.clientWidth || 1,
      h = this.host.clientHeight || 1;
    this.gl.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ track + scenery
  setTrack(track: Track) {
    disposeTree(this.world);
    this.world.clear();
    this.snap = true;
    const N = track.points.length;
    const P = track.points,
      H = track.headings,
      W = track.widths;
    const sp = track.spacing;
    const off = (i: number, o: number, y: number): P3 => [P[i][0] - Math.sin(H[i]) * o, y, P[i][1] + Math.cos(H[i]) * o];
    const loop = [...Array(N).keys(), 0];
    const range = (a: number, b: number) => {
      const out: number[] = [];
      for (let i = a; ; i = (i + 1) % N) {
        out.push(i);
        if (i === b % N || out.length > N) break;
      }
      return out;
    };
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const m = new THREE.Mesh(geo, mat);
      this.world.add(m);
      return m;
    };
    const rng = Rng.fromString(`3d:${track.seed}`);
    const b = track.bounds;
    const cx = (b.minX + b.maxX) / 2,
      cz = (b.minY + b.maxY) / 2;

    // Ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.MeshLambertMaterial({ color: 0x0d2414, map: noiseTexture('#0d2414', '#12301b', 60) }),
    );
    (ground.material as THREE.MeshLambertMaterial).map!.repeat.set(300, 300);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, -0.02, cz);
    this.world.add(ground);

    // Run-off (slightly lighter grass) both sides up to the wall
    const runMat = new THREE.MeshLambertMaterial({ color: 0x163a22 });
    add(strip(loop, (i, k) => off(i, k ? -W[i] / 2 : -W[i] / 2 - WALL_OFFSET, 0.01), 1, sp), runMat);
    add(strip(loop, (i, k) => off(i, k ? W[i] / 2 + WALL_OFFSET : W[i] / 2, 0.01), 1, sp), runMat);

    // Road
    const roadTex = roadTexture();
    add(strip(loop, (i, k) => off(i, k ? W[i] / 2 : -W[i] / 2, 0.03), 24, sp), new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.82, metalness: 0.05 }));

    // Kerbs at every corner, both sides
    const kerbMat = new THREE.MeshLambertMaterial({ map: stripeTexture('#e8eef5', '#e3122d'), side: THREE.DoubleSide });
    for (const c of track.corners) {
      const idx = range((c.start - 2 + N) % N, (c.end + 2) % N);
      add(strip(idx, (i, k) => off(i, k ? W[i] / 2 + 1.5 : W[i] / 2, 0.05), 4, sp), kerbMat);
      add(strip(idx, (i, k) => off(i, k ? -W[i] / 2 : -W[i] / 2 - 1.5, 0.05), 4, sp), kerbMat);
    }

    // Neon edge lines (bloom picks these up)
    const neon = new THREE.MeshBasicMaterial({ color: NEON });
    add(strip(loop, (i, k) => off(i, k ? W[i] / 2 + 2.2 : W[i] / 2 + 1.9, 0.06), 1, sp), neon);
    add(strip(loop, (i, k) => off(i, k ? -W[i] / 2 - 1.9 : -W[i] / 2 - 2.2, 0.06), 1, sp), neon);

    // Walls where the physics wall is, with a glowing top rail
    const wallMat = new THREE.MeshLambertMaterial({ map: wallTexture(), side: THREE.DoubleSide });
    const railMat = new THREE.MeshBasicMaterial({ color: 0x2bd96b, side: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const o = (i: number) => s * (W[i] / 2 + WALL_OFFSET);
      add(strip(loop, (i, k) => off(i, o(i), k ? 1.3 : 0), 6, sp), wallMat);
      add(strip(loop, (i, k) => off(i, o(i), k ? 1.45 : 1.3), 1, sp), railMat);
    }

    // Start / finish: checkered line + gantry with the brand
    const checker = new THREE.Mesh(new THREE.PlaneGeometry(3, W[0]), new THREE.MeshLambertMaterial({ map: checkerTexture() }));
    checker.rotation.order = 'YXZ';
    checker.rotation.set(-Math.PI / 2, -H[0], 0);
    checker.position.set(P[0][0], 0.045, P[0][1]);
    this.world.add(checker);
    this.world.add(gantry(P[0], H[0], W[0]));

    // Grandstands on the longest straights, on the outside of the circuit
    const straights: { a: number; n: number }[] = [];
    for (let i = 0, run = 0; i < N * 2; i++) {
      const j = i % N;
      if (Math.abs(track.curvature[j]) < 1 / 300) run++;
      else {
        if (run >= 9 && i - run < N) straights.push({ a: (i - run) % N, n: run });
        run = 0;
      }
    }
    straights.sort((x, y) => y.n - x.n);
    const crowdTex = crowdTexture(rng);
    let stands = 0;
    for (const st of straights) {
      if (stands >= 5) break;
      const m = (st.a + Math.floor(st.n / 2)) % N;
      const len = Math.min(st.n * sp * 0.75, 150);
      const [px, py] = P[m];
      const nx = -Math.sin(H[m]),
        ny = Math.cos(H[m]);
      const side = (px - cx) * nx + (py - cz) * ny > 0 ? 1 : -1; // outside of the circuit
      const dist = W[m] / 2 + WALL_OFFSET + 9;
      const g = grandstand(len, crowdTex, rng);
      g.position.set(px + nx * side * dist, 0, py + ny * side * dist);
      g.rotation.y = -H[m] + (side > 0 ? Math.PI : 0);
      this.world.add(g);
      stands++;
    }

    // Floodlight towers + pools of light on the road
    const pole = new THREE.CylinderGeometry(0.35, 0.5, 24, 6);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x3a4250 });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff4d6 });
    const pool = new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,236,190,0.55)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const step = Math.max(6, Math.round(95 / sp));
    for (let i = 0, s = 1; i < N; i += step, s = -s) {
      const o = s * (W[i] / 2 + WALL_OFFSET - 3);
      const [x, , z] = off(i, o, 0);
      const p = new THREE.Mesh(pole, poleMat);
      p.position.set(x, 12, z);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(4, 1.6, 0.6), lampMat);
      lamp.position.set(x, 24.5, z);
      lamp.rotation.y = -H[i];
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture('rgba(255,240,200,0.9)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.scale.set(16, 16, 1);
      glow.position.set(x, 24.5, z);
      const [lx, , lz] = off(i, s * W[i] * 0.15, 0);
      const pl = new THREE.Mesh(new THREE.CircleGeometry(W[i] * 1.1, 24), pool);
      pl.rotation.x = -Math.PI / 2;
      pl.position.set(lx, 0.07, lz);
      this.world.add(p, lamp, glow, pl);
    }

    // Trees: scattered outside the walls
    const pts = P.filter((_, i) => i % 2 === 0);
    const maxW = Math.max(...W) / 2 + WALL_OFFSET + 8;
    const treeSpots: [number, number, number][] = [];
    for (let k = 0; k < 4200 && treeSpots.length < 1400; k++) {
      const x = b.minX - 260 + rng.next() * (b.maxX - b.minX + 520);
      const z = b.minY - 260 + rng.next() * (b.maxY - b.minY + 520);
      let best = Infinity;
      for (const p of pts) {
        const d = (p[0] - x) ** 2 + (p[1] - z) ** 2;
        if (d < best) best = d;
      }
      if (best > maxW * maxW && best < 300 * 300) treeSpots.push([x, z, 0.7 + rng.next() * 0.8]);
    }
    const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(4, 11, 7), new THREE.MeshLambertMaterial({ color: 0x0f3a1c }), treeSpots.length);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.45, 0.6, 3, 5), new THREE.MeshLambertMaterial({ color: 0x2a1d14 }), treeSpots.length);
    const mtx = new THREE.Matrix4();
    treeSpots.forEach(([x, z, s], i) => {
      mtx.makeScale(s, s, s).setPosition(x, 1.5 * s + 5.5 * s, z);
      crown.setMatrixAt(i, mtx);
      mtx.makeScale(s, s, s).setPosition(x, 1.5 * s, z);
      trunk.setMatrixAt(i, mtx);
    });
    this.world.add(crown, trunk);

    // Paddock tents with warm lights in the infield near the start
    const tentMat = new THREE.MeshLambertMaterial({ color: 0xe6e9ef });
    const warm = new THREE.MeshBasicMaterial({ color: 0xffb347 });
    const inSide = (() => {
      const nx = -Math.sin(H[0]),
        ny = Math.cos(H[0]);
      return (P[0][0] - cx) * nx + (P[0][1] - cz) * ny > 0 ? -1 : 1;
    })();
    for (let t = 0; t < 10; t++) {
      const i = (t * 2 + N - 8) % N;
      const [x, , z] = off(i, inSide * (W[i] / 2 + WALL_OFFSET + 10 + (t % 2) * 9), 0);
      const tent = new THREE.Mesh(new THREE.ConeGeometry(3.6, 3.4, 4), tentMat);
      tent.position.set(x, 1.7, z);
      tent.rotation.y = Math.PI / 4 - H[i];
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 1.2), warm);
      lamp.position.set(x, 0.4, z);
      this.world.add(tent, lamp);
    }
  }

  // ------------------------------------------------------------------ cars
  setCars(entries: { name: string; color: string }[], you: number) {
    for (const c of this.cars) {
      c.label?.material.map?.dispose();
      c.label?.material.dispose();
      this.carGroup.remove(c.group);
    }
    this.cars = entries.map((e, i) => {
      const m = carModel(e.color, this.shared);
      if (i !== you) {
        m.label = labelSprite(e.name, e.color);
        m.label.position.set(0, 2.8, 0);
        m.group.add(m.label);
      }
      this.carGroup.add(m.group);
      return m;
    });
    this.snap = true;
  }

  render(cars: CarVisual[], focus: number, dt: number) {
    if (!this.visible) return;
    const cam = this.camera.position;
    cars.forEach((c, i) => {
      const m = this.cars[i];
      if (!m || !c) return;
      m.group.position.set(c.x, 0, c.y);
      m.group.rotation.y = -c.h;
      m.tail.color.setHex(c.flags & FLAG.braking ? 0xff3355 : 0x99101f);
      if (m.label) {
        // No tag on the car we're riding with, and none right in front of the lens.
        const d = Math.hypot(c.x - cam.x, c.y - cam.z);
        m.label.visible = i !== focus && d > 14 && d < 260;
      }
    });
    const f = cars[focus];
    if (f) {
      const dx = Math.cos(f.h),
        dz = Math.sin(f.h);
      const back = 10.5 + Math.min(4, f.speed * 0.05);
      const want = new THREE.Vector3(f.x - dx * back, 3.8, f.y - dz * back);
      const look = new THREE.Vector3(f.x + dx * 9, 1.2, f.y + dz * 9);
      if (this.snap) {
        this.camPos.copy(want);
        this.camLook.copy(look);
        this.snap = false;
      } else {
        this.camPos.lerp(want, 1 - Math.exp(-dt * 7));
        this.camLook.lerp(look, 1 - Math.exp(-dt * 12));
      }
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
      const fov = 60 + Math.min(14, f.speed * 0.22);
      if (Math.abs(fov - this.camera.fov) > 0.05) {
        this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 4);
        this.camera.updateProjectionMatrix();
      }
    }
    this.composer.render(dt);
  }
}

// ---------------------------------------------------------------------- geometry helpers

/** A ribbon along the centerline: pt(i, 0|1) gives the two edge points at centerline index i. */
function strip(idxs: number[], pt: (i: number, k: 0 | 1) => P3, vLen: number, spacing: number): THREE.BufferGeometry {
  const pos: number[] = [],
    uv: number[] = [],
    ind: number[] = [];
  idxs.forEach((i, j) => {
    pos.push(...pt(i, 0), ...pt(i, 1));
    const v = (j * spacing) / vLen;
    uv.push(0, v, 1, v);
    if (j > 0) {
      const q = (j - 1) * 2;
      ind.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(ind);
  g.computeVertexNormals();
  return g;
}

function gantry(p: [number, number], h: number, w: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x1a1f27 });
  const half = w / 2 + 3;
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1, 9, 1), mat);
    leg.position.set(0, 4.5, s * half);
    g.add(leg);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.6, half * 2 + 1), mat);
  beam.position.set(0, 9.2, 0);
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(half * 1.6, 2.1), new THREE.MeshBasicMaterial({ map: bannerTexture(), side: THREE.DoubleSide }));
  banner.position.set(-0.65, 9.2, 0);
  banner.rotation.y = -Math.PI / 2;
  const banner2 = banner.clone();
  banner2.position.x = 0.65;
  banner2.rotation.y = Math.PI / 2;
  g.add(beam, banner, banner2);
  g.position.set(p[0], 0, p[1]);
  g.rotation.y = -h;
  return g;
}

/** Stand facing local -z (towards the track), running along local x. */
function grandstand(len: number, crowd: THREE.Texture, rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const frame = new THREE.MeshLambertMaterial({ color: 0x1c222c });
  const depth = 14,
    height = 9;
  const back = new THREE.Mesh(new THREE.BoxGeometry(len, height, 1), frame);
  back.position.set(0, height / 2, depth / 2);
  const tex = crowd.clone();
  tex.needsUpdate = true;
  tex.repeat.set(len / 20, 1);
  const seats = new THREE.Mesh(new THREE.PlaneGeometry(len, Math.hypot(depth, height)), new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35 }));
  seats.position.set(0, height / 2, 0);
  seats.rotation.x = -Math.atan2(depth, height); // tilt back: rows rise away from the track
  const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 2, 0.5, depth + 3), frame);
  roof.position.set(0, height + 3, 0.5);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(len + 2, 0.25, 0.25), new THREE.MeshBasicMaterial({ color: 0x8cff2e }));
  edge.position.set(0, height + 2.7, -depth / 2 - 1);
  const front = new THREE.Mesh(new THREE.BoxGeometry(len, 1.2, 0.4), new THREE.MeshBasicMaterial({ color: rng.next() < 0.5 ? 0x22d3ee : 0xff3dbb }));
  front.position.set(0, 0.6, -depth / 2 - 0.2);
  g.add(back, seats, roof, edge, front);
  // Big screen on the roof
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(14, 7), new THREE.MeshBasicMaterial({ map: screenTexture(), side: THREE.DoubleSide }));
  screen.position.set(len * 0.25, height + 8, 0);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 5, 0.6), frame);
  post.position.set(len * 0.25, height + 4.5, 0.3);
  g.add(screen, post);
  return g;
}

function sharedCarParts() {
  return {
    body: new THREE.BoxGeometry(4.4, 0.55, 1.9),
    nose: new THREE.BoxGeometry(1.3, 0.32, 1.5),
    cabin: new THREE.BoxGeometry(1.7, 0.5, 1.3),
    wing: new THREE.BoxGeometry(0.45, 0.08, 2.15),
    wheel: new THREE.CylinderGeometry(0.4, 0.4, 0.36, 12).rotateX(Math.PI / 2),
    light: new THREE.BoxGeometry(0.08, 0.14, 1.5),
    head: new THREE.BoxGeometry(0.08, 0.12, 0.35),
    glass: new THREE.MeshStandardMaterial({ color: 0x0a101c, metalness: 0.8, roughness: 0.15 }),
    tyre: new THREE.MeshLambertMaterial({ color: 0x111111 }),
    headMat: new THREE.MeshBasicMaterial({ color: 0xeaf6ff }),
    glow: radialTexture('rgba(255,255,255,0.9)'),
  };
}

function carModel(color: string, S: ReturnType<typeof sharedCarParts>): CarModel {
  const g = new THREE.Group();
  const c = new THREE.Color(color);
  const paint = new THREE.MeshStandardMaterial({ color: c, metalness: 0.45, roughness: 0.32, emissive: c, emissiveIntensity: 0.12 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  add(S.body, paint, 0, 0.55, 0);
  add(S.nose, paint, 2.6, 0.45, 0);
  add(S.cabin, S.glass, -0.3, 1.05, 0);
  add(S.wing, paint, -2.25, 1.3, 0);
  for (const x of [1.45, -1.45]) for (const z of [0.98, -0.98]) add(S.wheel, S.tyre, x, 0.4, z);
  const tail = new THREE.MeshBasicMaterial({ color: 0x99101f });
  add(S.light, tail, -2.22, 0.66, 0);
  add(S.head, S.headMat, 3.26, 0.48, 0.5);
  add(S.head, S.headMat, 3.26, 0.48, -0.5);
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(6.2, 3.2),
    new THREE.MeshBasicMaterial({ map: S.glow, color: c, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.08;
  g.add(glow);
  return { group: g, tail, label: null };
}

// ---------------------------------------------------------------------- textures (drawn on canvases)

function canvasTex(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, repeat = true): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function skyTexture() {
  const t = canvasTex(4, 512, (c) => {
    const g = c.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#01030a');
    g.addColorStop(0.55, '#0a1630');
    g.addColorStop(1, '#1c3150');
    c.fillStyle = g;
    c.fillRect(0, 0, 4, 512);
  }, false);
  return t;
}

function noiseTexture(base: string, fleck: string, n: number) {
  return canvasTex(64, 64, (c) => {
    c.fillStyle = base;
    c.fillRect(0, 0, 64, 64);
    c.fillStyle = fleck;
    for (let i = 0; i < n; i++) c.fillRect((i * 37) % 64, (i * 23 + (i * i) % 17) % 64, 2, 2);
  });
}

function roadTexture() {
  return canvasTex(128, 512, (c) => {
    c.fillStyle = '#2a2d33';
    c.fillRect(0, 0, 128, 512);
    for (let i = 0; i < 1400; i++) {
      c.fillStyle = i % 2 ? '#30343b' : '#24272c';
      c.fillRect((i * 53) % 128, (i * 97 + i * i) % 512, 2, 2);
    }
    c.fillStyle = '#e9eef4';
    c.fillRect(3, 0, 4, 512); // edge lines
    c.fillRect(121, 0, 4, 512);
    c.fillRect(62, 0, 4, 200); // dashed centre line
  });
}

function stripeTexture(a: string, b: string) {
  return canvasTex(8, 64, (c) => {
    c.fillStyle = a;
    c.fillRect(0, 0, 8, 32);
    c.fillStyle = b;
    c.fillRect(0, 32, 8, 32);
  });
}

function wallTexture() {
  return canvasTex(64, 64, (c) => {
    c.fillStyle = '#20262f';
    c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#2d3540';
    c.fillRect(0, 26, 64, 12);
  });
}

function checkerTexture() {
  return canvasTex(64, 256, (c) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 4; x++) {
        c.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
        c.fillRect(x * 16, y * 16, 16, 16);
      }
  }, false);
}

function radialTexture(inner: string) {
  return canvasTex(128, 128, (c) => {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, inner);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
  }, false);
}

function crowdTexture(rng: Rng) {
  const colors = ['#f5f5f5', '#ffd60a', '#ff3b3b', '#3b82ff', '#8cff2e', '#ff3dbb', '#a259ff', '#ff8a1f', '#d4d4d8', '#22d3ee'];
  return canvasTex(256, 128, (c) => {
    c.fillStyle = '#141922';
    c.fillRect(0, 0, 256, 128);
    for (let row = 0; row < 16; row++) {
      c.fillStyle = '#0d1118';
      c.fillRect(0, row * 8 + 6, 256, 2);
      for (let x = 2; x < 256; x += 5) {
        if (rng.next() < 0.12) continue;
        c.fillStyle = colors[Math.floor(rng.next() * colors.length)];
        c.fillRect(x, row * 8 + 1, 3, 4);
      }
    }
  });
}

function bannerTexture() {
  return canvasTex(512, 64, (c) => {
    c.fillStyle = '#07090c';
    c.fillRect(0, 0, 512, 64);
    c.fillStyle = '#8cff2e';
    c.fillRect(0, 0, 512, 4);
    c.fillRect(0, 60, 512, 4);
    c.font = 'italic 800 38px "Exo 2", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#ffffff';
    c.fillText('TRACKLAB', 220, 34);
    c.fillStyle = '#8cff2e';
    c.fillText('2D', 345, 34);
    for (let i = 0; i < 4; i++) {
      c.fillStyle = i % 2 ? '#fff' : '#111';
      c.fillRect(40 + i * 10, 22, 10, 10);
      c.fillRect(440 + i * 10, 32, 10, 10);
    }
  }, false);
}

function screenTexture() {
  return canvasTex(256, 128, (c) => {
    const g = c.createLinearGradient(0, 0, 256, 128);
    g.addColorStop(0, '#0b2a5a');
    g.addColorStop(1, '#3a0f4f');
    c.fillStyle = g;
    c.fillRect(0, 0, 256, 128);
    c.strokeStyle = '#8cff2e';
    c.lineWidth = 6;
    c.strokeRect(3, 3, 250, 122);
    c.font = 'italic 800 34px "Exo 2", sans-serif';
    c.textAlign = 'center';
    c.fillStyle = '#ffffff';
    c.fillText('LIVE', 128, 60);
    c.fillStyle = '#8cff2e';
    c.font = '600 18px "Barlow", sans-serif';
    c.fillText('TRACKLAB 2D', 128, 92);
  }, false);
}

function labelSprite(name: string, color: string): THREE.Sprite {
  const tex = canvasTex(256, 64, (c) => {
    c.font = '700 26px "Barlow", sans-serif';
    const w = Math.min(240, c.measureText(name).width + 34);
    const x0 = 128 - w / 2;
    c.fillStyle = 'rgba(6,9,12,0.85)';
    c.beginPath();
    c.roundRect(x0, 10, w, 42, 8);
    c.fill();
    c.fillStyle = color;
    c.fillRect(x0 + 8, 20, 6, 22);
    c.fillStyle = '#ffffff';
    c.textBaseline = 'middle';
    c.fillText(name, x0 + 22, 32, w - 28);
  }, false);
  // Tinted grey so the white text stays under the bloom threshold (no glow smear).
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0x9a9a9a, transparent: true, depthWrite: false }));
  s.scale.set(5.6, 1.4, 1);
  return s;
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      (mat as THREE.MeshBasicMaterial).map?.dispose();
      mat.dispose();
    }
  });
}
