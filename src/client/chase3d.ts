// Realistic 3D race view (chase camera). Same race as the 2D map: sim (x, y) -> three (x, 0, y),
// heading h -> rotation.y = -h. Loaded on demand so the 2D map pages never download three.js or the assets.
//
// Assets (public/assets, credited in README):
//   - Orangie turbo wheelchair racer (made with Tripo, public/assets/characters)
//   - Poly Haven CC0: asphalt_02, aerial_grass_rock, pine_bark textures; rogland_clear_night HDRI
// Everything else (trees, crowd, stands, fences, kerbs, ad boards) is generated here.
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Track } from '../sim/track';
import { PHYS } from '../sim/physics';
import { FLAG, type RaceEvent } from '../sim/race';
import { Rng } from '../sim/rng';
import type { Obstacles } from '../sim/obstacles';
import type { CarVisual } from './renderer';
import { buildKart } from './kart';
import { buildRacer, loadSkin, skinLoaded } from './racer3d';
import { DEFAULT_SKIN } from '../game/skins';
import { CARD_H, CARD_W, MAX_IMPACTS, MAX_CARS_UNIFORM, VARIANTS, bakeAtlas, cardMaterial, crowdUniforms, humanGeometry, humanMaterial, lookAttributes, type CrowdUniforms } from './crowd3d';

const ASSET = (p: string) => `${import.meta.env.BASE_URL}assets/${p}`;
const WALL = PHYS.runoff; // physical wall: this far beyond the track edge
const NEAR_FANS = 2600; // fans drawn as full 3D people (closest to the camera)
const NEAR_RADIUS = 70; // m

type P3 = [number, number, number];
type Pt = [number, number];

interface CarModel {
  root: THREE.Group;
  body: THREE.Object3D;
  wheels: THREE.Object3D[];
  front: THREE.Object3D[];
  tail: THREE.MeshStandardMaterial | null;
  label: THREE.Sprite | null;
  prevH: number;
  prevSpeed: number;
  spin: number;
  pitch: number;
  roll: number;
  skid: [Pt | null, Pt | null];
  wheelR: number; // m, for wheel spin
  height: number; // m, for the name tag
  animate?: (t: number, dt: number, speed: number, yawRate: number, accel: number) => void; // per-frame extras (rider, wheels, flames)
}

interface TreePart {
  mesh: THREE.InstancedMesh;
  index: number;
  local: THREE.Matrix4;
}

interface TreeAnim {
  shake0: number;
  shakeAmp: number;
  fall0: number; // -99 = not falling (shake only); -999 = already down when we joined
  dirX: number;
  dirZ: number;
}

interface Person {
  x: number;
  y: number;
  z: number;
  dx: number; // direction away from the track (to back off when a car hits the fence)
  dz: number;
  v: number; // look variant
  ph: number; // animation phase
  seat: number; // 1 = sitting (grandstands)
}

/** A place spectators can watch from. The fan camera moves inside it with (u, v). */
export interface SeatArea {
  name: string;
  kind: 'stand' | 'terrace' | 'platform';
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  du: number; // default spot
  dv: number;
  at(u: number, v: number): { pos: THREE.Vector3; face: THREE.Vector3 };
  outline: Pt[]; // for the seat-picker map
}

export interface FanStatus {
  area: string;
  detail: string;
  follow: boolean;
  auto: boolean;
}

// Materials from loadTextures() live for the whole session; never dispose them with a track.
const sharedMats = new WeakSet<THREE.Material>();

export class Chase3D {
  readonly canvas: HTMLCanvasElement;
  private gl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.3, 3000);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private world = new THREE.Group();
  private obsGroup = new THREE.Group();
  private carGroup = new THREE.Group();
  private cars: CarModel[] = [];
  private carsToken: object | null = null; // the setCars call waiting for skins to download
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private snap = true;
  private time = 0;
  private shake = 0;
  private focusIdx = -1;
  private track: Track | null = null;
  private ob: Obstacles | null = null;
  // lights
  private moon: THREE.DirectionalLight;
  private spots: THREE.SpotLight[] = [];
  private towers: { pos: THREE.Vector3; aim: THREE.Vector3 }[] = [];
  private headlight: THREE.SpotLight;
  // assets
  /** Resolves once the sky, the car model and every shader the game draws with are ready. */
  readonly ready: Promise<void>;
  private T: Mats;
  // trees
  private treeParts: TreePart[][] = [];
  private treeAnim = new Map<number, TreeAnim>();
  // crowd
  private standPeople: Person[] = [];
  private zonePeople: Person[] = [];
  private cu: CrowdUniforms;
  private humanMat: THREE.MeshStandardMaterial;
  private cardMat: THREE.ShaderMaterial;
  private nearMesh: THREE.Mesh | null = null; // 3D fans
  private farMesh: THREE.Mesh | null = null; // baked cards
  private fans: Person[] = [];
  private fanLooks: ReturnType<typeof lookAttributes> | null = null;
  private lastSplit = new THREE.Vector3(1e9, 0, 0);
  private splitAt = 0;
  private impactSlot = 0;
  private excite = 0;
  // fx
  private fx: Particles;
  private sparks: Particles;
  private skids: SkidMarks;
  // camera: 'chase' behind the focus car, 'fan' = first person from a spectator spot
  camMode: 'chase' | 'fan' = 'chase';
  private areas: SeatArea[] = [];
  private standAreas: SeatArea[] = [];
  private seat: { a: number; u: number; v: number } = { a: -1, u: 0, v: 0 };
  private autoSeat = true; // walk to the stand nearest the action until the viewer picks a seat
  private follow = true; // head follows the car; dragging switches to free look
  private yaw = 0;
  private pitch = 0;
  private userFov = 0; // 0 = automatic
  private tourS = 0; // flyover camera: metres travelled along the track
  private eye = new THREE.Vector3();
  private walkKeys = new Set<string>();
  private dragging: { x: number; y: number } | null = null;
  // quality: 3 = full, 2 = lower resolution, 1 = no bloom + slower shadow refresh, 0 = minimum
  private quality = 3;
  private frameAcc = 0;
  private frameN = 0;
  private lastFrame = 0;

  constructor(private host: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    // Asking the driver "did this shader compile?" blocks until it has; skip that outside development.
    this.gl.debug.checkShaderErrors = import.meta.env.DEV;
    this.canvas = this.gl.domElement;
    this.canvas.className = 'chase3d';
    this.canvas.style.display = 'none';
    host.appendChild(this.canvas);
    this.fade.className = 'swap-fade';
    this.fade.innerHTML = '<span>NEXT TRACK</span>';
    host.appendChild(this.fade);

    this.scene.background = new THREE.Color(0x070b14);
    this.scene.fog = new THREE.Fog(0x0b1220, 140, 900);
    this.scene.add(new THREE.HemisphereLight(0x5a6b90, 0x10180f, 0.35));
    this.moon = new THREE.DirectionalLight(0xbcd0ff, 0.9);
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(1536, 1536);
    const sc = this.moon.shadow.camera;
    sc.left = sc.bottom = -45;
    sc.right = sc.top = 45;
    sc.near = 1;
    sc.far = 300;
    this.moon.shadow.bias = -0.0005;
    this.moon.shadow.normalBias = 0.03;
    this.scene.add(this.moon, this.moon.target);
    // Floodlights: a small pool of real spot lights moved to the towers nearest the camera
    for (let i = 0; i < 3; i++) {
      const s = new THREE.SpotLight(0xfff0d0, 1600, 110, 0.7, 0.8, 1.8);
      this.spots.push(s);
      this.scene.add(s, s.target);
    }
    this.headlight = new THREE.SpotLight(0xf2f6ff, 220, 60, 0.4, 0.6, 1.6);
    this.scene.add(this.headlight, this.headlight.target);
    this.scene.add(this.world, this.obsGroup, this.carGroup);

    this.T = loadTextures(this.gl);
    // The sky and the car change which shader every material needs, so 3D waits for both (and then
    // compiles everything up front) instead of compiling mid-race, which froze the page for seconds.
    const sky = new Promise<void>((done) =>
      new HDRLoader().load(
        ASSET('tex/night_1k.hdr'),
        (t) => {
          t.mapping = THREE.EquirectangularReflectionMapping;
          this.scene.environment = t;
          this.scene.environmentIntensity = 0.9;
          this.scene.background = t;
          this.scene.backgroundIntensity = 0.55;
          done();
        },
        undefined,
        () => done(),
      ),
    );
    const car = loadSkin(DEFAULT_SKIN); // the free racer; other skins load when a race needs them

    this.cu = crowdUniforms();
    this.humanMat = humanMaterial(this.cu);
    this.cardMat = cardMaterial(this.cu, bakeAtlas(this.gl, this.cu));
    this.bindFanControls();

    this.fx = new Particles(1800, THREE.NormalBlending);
    this.sparks = new Particles(600, THREE.AdditiveBlending);
    this.skids = new SkidMarks(2500);
    this.scene.add(this.fx.points, this.sparks.points, this.skids.mesh);

    this.composer = new EffectComposer(this.gl);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.45, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    new ResizeObserver(() => this.resize()).observe(host);
    this.applyQuality(this.startQuality());
    const timeout = new Promise<void>((done) => setTimeout(done, 20_000)); // slow network: don't wait forever
    this.ready = Promise.race([Promise.all([sky, car]), timeout]).then(() => this.warmUp());
  }

  get visible() {
    return this.canvas.style.display !== 'none';
  }

  setVisible(v: boolean) {
    if (v === this.visible) return;
    this.canvas.style.display = v ? 'block' : 'none';
    this.calmUntil = performance.now() + 2000;
    if (!v && !this.covering) {
      this.fade.classList.remove('on');
      this.swapFrames = 0;
    }
    this.snap = true;
    if (v) this.resize();
  }

  /**
   * Watch real frame times; step quality down if the machine can't keep ~45 fps. Only things that
   * don't recompile shaders are changed (toggling lights or shadow casting would freeze the game
   * for seconds while every material recompiles): resolution, shadow map size/refresh, bloom.
   */
  /**
   * Graphics: 'auto' starts high (or medium on laptop/phone GPUs) and steps down whenever the
   * last ~2 s averaged under ~50 fps; 'high' and 'low' are fixed. Only settings that don't recompile
   * shaders change (toggling lights or shadow casting would freeze for seconds while everything
   * recompiles): resolution, shadow map size and refresh rate, bloom.
   */
  graphics: GfxMode = readGfx();

  setGraphics(mode: GfxMode) {
    this.graphics = mode;
    try {
      localStorage.setItem('tl-gfx', mode);
    } catch {
      /* ignore */
    }
    this.applyQuality(mode === 'high' ? 3 : mode === 'low' ? 1 : this.startQuality());
  }

  /** Which chip the browser draws with, e.g. "Intel(R) Iris(R) Xe Graphics" ('' if it won't say). */
  get gpuName(): string {
    if (this.gpu === undefined) {
      try {
        const ctx = this.gl.getContext();
        const info = ctx.getExtension('WEBGL_debug_renderer_info');
        const raw = info ? String(ctx.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
        this.gpu = raw.replace(/^ANGLE \([^,]*, /, '').replace(/ \(0x[0-9a-f]+\)| Direct3D.*$| vs_.*$/gi, '').replace(/\)$/, '').trim();
      } catch {
        this.gpu = '';
      }
    }
    return this.gpu;
  }
  private gpu: string | undefined;

  /** True when there is no hardware acceleration: the browser draws 3D on the CPU (very slow). */
  get software(): boolean {
    return /swiftshader|llvmpipe|softpipe|basic render|software/i.test(this.gpuName);
  }

  private startQuality(): number {
    if (this.software) return 0;
    if (this.graphics === 'high') return 3;
    if (this.graphics === 'low') return 1;
    const weak =
      (navigator.hardwareConcurrency || 8) <= 4 ||
      matchMedia('(pointer: coarse)').matches ||
      /intel|uhd|iris|hd graphics|mali|adreno|powervr|vega [0-9] |radeon\(tm\) graphics/i.test(this.gpuName);
    return weak ? 2 : 3;
  }

  private applyQuality(q: number) {
    this.quality = q;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const L = [
      { ratio: 0.5, shadow: 512, bloom: false, every: 6 },
      { ratio: 0.65, shadow: 1024, bloom: false, every: 3 },
      { ratio: 0.8, shadow: 1024, bloom: true, every: 1 },
      { ratio: 1, shadow: 1536, bloom: true, every: 1 },
    ][Math.max(0, Math.min(3, q))];
    this.gl.setPixelRatio(Math.max(0.5, dpr * L.ratio));
    if (this.moon.shadow.mapSize.x !== L.shadow) {
      this.moon.shadow.mapSize.set(L.shadow, L.shadow);
      this.moon.shadow.map?.dispose();
      this.moon.shadow.map = null;
    }
    this.bloom.enabled = L.bloom;
    this.shadowEvery = L.every;
    this.gl.shadowMap.autoUpdate = L.every === 1;
    this.gl.shadowMap.needsUpdate = true;
    // Trees are drawn twice when they cast shadows (all of them, every frame): only on the top setting.
    // castShadow doesn't change any shader, so this is free to toggle.
    this.scene.traverse((o) => {
      if (o.name === 'treepart') o.castShadow = q >= 3;
    });
    this.splitAt = 0; // re-pick which fans are full 3D for the new radius
    this.resize();
  }
  private shadowEvery = 1;
  private calmUntil = 0; // adaptive quality ignores frames until then (just after a swap)
  private slowRun = 0;
  private slowNotified = false;
  private frameNo = 0;
  private heldDt = 0;

  private adaptQuality() {
    const now = performance.now();
    const ft = this.lastFrame ? now - this.lastFrame : 16;
    this.lastFrame = now;
    if (this.time < 3 || this.graphics !== 'auto') return; // loading / fixed setting
    // Only judge ordinary frames: not track swaps / page switches (and the 2 s after), not one-off spikes.
    if (this.swap || this.covering || this.swapFrames > 0 || now < this.calmUntil) {
      this.frameAcc = this.frameN = 0;
      return;
    }
    if (ft > 100) {
      // a one-off spike is ignored, but a run of them means this machine is really struggling
      if (++this.slowRun >= 10 && this.quality > 0) {
        this.slowRun = 0;
        this.applyQuality(this.quality - 1);
        this.calmUntil = now + 1000;
      }
      return;
    }
    this.slowRun = 0;
    this.frameAcc += ft;
    this.frameN++;
    if (this.frameAcc < 2000) return;
    const avg = this.frameAcc / this.frameN;
    this.frameAcc = this.frameN = 0;
    if (avg < 20) return;
    if (this.quality === 0) {
      // Already as light as it gets and still under ~30 fps: tell the player what helps (once).
      if (avg > 33 && !this.slowNotified) {
        this.slowNotified = true;
        window.dispatchEvent(new CustomEvent('tl-slow', { detail: { gpu: this.gpuName, software: this.software } }));
      }
      return;
    }
    this.applyQuality(this.quality - 1);
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

  // ==================================================================== track + scenery
  // Track changes while the 3D view is on screen: dip to dark, build the new world (and upload it
  // to the GPU) behind it, then fade back in, so the unavoidable work reads as a cut, not a freeze.
  private fade = document.createElement('div');
  private swap: { track: Track; ob: Obstacles | null | undefined } | null = null;
  private swapFrames = 0;

  private covering = false; // a page switch is under way: track changes go behind the dark layer too
  private coverTimer: ReturnType<typeof setTimeout> | undefined;

  /** Page switch (AI League <-> Race <-> Lab): dip to dark now, fade in once the new view is drawn. */
  cover(label: string) {
    (this.fade.firstElementChild as HTMLElement).textContent = label;
    this.fade.classList.add('on');
    this.covering = true;
    clearTimeout(this.coverTimer);
    // Fallback: the new page may not use 3D (map view) or may not change track at all.
    this.coverTimer = setTimeout(() => {
      this.covering = false;
      if (!this.swap && (this.swapFrames === 0 || !this.visible)) {
        this.swapFrames = 0;
        this.fade.classList.remove('on');
      }
    }, 900);
  }

  setTrack(track: Track) {
    if (!this.visible && !this.covering) {
      this.swap = null;
      this.buildWorld(track);
      return;
    }
    const first = !this.swap;
    this.swap = { track, ob: undefined };
    if (!first) return; // already fading: the newest track wins
    if (!this.covering) (this.fade.firstElementChild as HTMLElement).textContent = 'NEXT TRACK';
    this.fade.classList.add('on');
    setTimeout(() => {
      const sw = this.swap;
      if (!sw) return;
      this.swap = null;
      this.buildWorld(sw.track);
      if (sw.ob !== undefined) this.applyObstacles(sw.ob);
      this.swapFrames = 3; // first frames upload the new world; keep them under the dark layer
    }, 170);
  }

  private buildWorld(track: Track) {
    this.track = track;
    disposeTree(this.world);
    this.world.clear();
    this.setObstacles(null);
    this.skids.clear();
    this.snap = true;
    const T = this.T;
    const N = track.points.length;
    const P = track.points,
      H = track.headings,
      W = track.widths;
    const sp = track.spacing;
    const off = (i: number, o: number, y: number): P3 => [P[i][0] - Math.sin(H[i]) * o, y, P[i][1] + Math.cos(H[i]) * o];
    /** Flat band between lateral offsets a < b (a ribbon facing up). */
    const band = (idx: number[], a: (i: number) => number, b: (i: number) => number, y: number, vLen: number, u?: (i: number, k: 0 | 1) => number) =>
      strip(idx, (i, k) => off(i, k ? b(i) : a(i), y), vLen, sp, u);
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
      m.receiveShadow = true;
      this.world.add(m);
      return m;
    };
    const rng = Rng.fromString(`3d:${track.seed}`);
    const b = track.bounds;
    const cx = (b.minX + b.maxX) / 2,
      cz = (b.minY + b.maxY) / 2;

    // Ground (grass)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), T.grass);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, -0.03, cz);
    ground.receiveShadow = true;
    this.world.add(ground);

    // Road + painted edge lines
    add(band(loop, (i) => -W[i] / 2, (i) => W[i] / 2, 0.02, 6, (i, k) => (k ? W[i] / 2 : -W[i] / 2) / 6), T.asphalt);
    add(band(loop, (i) => W[i] / 2 - 0.6, (i) => W[i] / 2 - 0.3, 0.03, 1), T.paint);
    add(band(loop, (i) => -W[i] / 2 + 0.3, (i) => -W[i] / 2 + 0.6, 0.03, 1), T.paint);
    // Kerbs both sides of every corner, gravel trap on the outside
    for (const c of track.corners) {
      const idx = range((c.start - 2 + N) % N, (c.end + 2) % N);
      add(band(idx, (i) => W[i] / 2, (i) => W[i] / 2 + 1.4, 0.05, 4), T.kerb);
      add(band(idx, (i) => -W[i] / 2 - 1.4, (i) => -W[i] / 2, 0.05, 4), T.kerb);
      const outer = c.direction === 'right' ? -1 : 1;
      if (outer > 0) add(band(idx, (i) => W[i] / 2 + 1.4, (i) => W[i] / 2 + 9, 0.015, 8), T.gravel);
      else add(band(idx, (i) => -W[i] / 2 - 9, (i) => -W[i] / 2 - 1.4, 0.015, 8), T.gravel);
    }
    // Start/finish line + gantry
    const checker = new THREE.Mesh(new THREE.PlaneGeometry(2.4, W[0]), new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.8, color: 0xa8a8a8 }));
    checker.rotation.order = 'YXZ';
    checker.rotation.set(-Math.PI / 2, -H[0], 0);
    checker.position.set(P[0][0], 0.035, P[0][1]);
    checker.receiveShadow = true;
    this.world.add(checker);
    this.world.add(gantry(P[0], H[0], W[0]));

    // Armco + concrete along the physical wall, posts, tyre walls on the outside of corners
    for (const s of [-1, 1]) {
      const pts = loop.map((i) => [P[i][0] - Math.sin(H[i]) * s * (W[i] / 2 + WALL), P[i][1] + Math.cos(H[i]) * s * (W[i] / 2 + WALL)] as Pt);
      add(vstrip(pts, 0.45, 0.82, 4), T.armco).castShadow = true;
      add(vstrip(pts, 0.0, 0.45, 4), T.concrete);
    }
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.85, 0.12), T.steel, N * 4);
    let pc = 0;
    const m4 = new THREE.Matrix4();
    for (const s of [-1, 1])
      for (let i = 0; i < N; i++)
        for (const f of [0, 0.5]) {
          const j = (i + 1) % N;
          const a = off(i, s * (W[i] / 2 + WALL + 0.12), 0),
            c2 = off(j, s * (W[j] / 2 + WALL + 0.12), 0);
          m4.makeTranslation(a[0] + (c2[0] - a[0]) * f, 0.42, a[2] + (c2[2] - a[2]) * f);
          posts.setMatrixAt(pc++, m4);
        }
    posts.count = pc;
    this.world.add(posts);
    const tyres: THREE.Matrix4[] = [];
    for (const c of track.corners) {
      const outer = c.direction === 'right' ? -1 : 1;
      for (const i of range((c.start - 1 + N) % N, (c.end + 1) % N)) {
        const j = (i + 1) % N;
        const a = off(i, outer * (W[i] / 2 + WALL - 0.55), 0),
          c2 = off(j, outer * (W[j] / 2 + WALL - 0.55), 0);
        for (let f = 0; f < 1; f += 0.09)
          for (let h = 0; h < 3; h++) tyres.push(new THREE.Matrix4().makeTranslation(a[0] + (c2[0] - a[0]) * f, 0.17 + h * 0.31, a[2] + (c2[2] - a[2]) * f));
      }
    }
    if (tyres.length) {
      const tyreMesh = new THREE.InstancedMesh(new THREE.TorusGeometry(0.32, 0.16, 8, 14).rotateX(Math.PI / 2), T.rubber, tyres.length);
      tyres.forEach((m, i) => tyreMesh.setMatrixAt(i, m));
      tyreMesh.castShadow = true;
      this.world.add(tyreMesh);
    }

    // Grandstands on the longest straights, outside the wall, with a seated crowd
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
    this.standPeople = [];
    this.standAreas = [];
    for (const st of straights.slice(0, 4)) {
      const m = (st.a + Math.floor(st.n / 2)) % N;
      const len = Math.min(st.n * sp * 0.7, 140);
      const nx = -Math.sin(H[m]),
        nz = Math.cos(H[m]);
      const side = (P[m][0] - cx) * nx + (P[m][1] - cz) * nz > 0 ? 1 : -1;
      const dist = W[m] / 2 + WALL + 6;
      // rotation -h puts local +z on the right of the track: a stand on the right must turn round to face it
      const sx = P[m][0] + nx * side * dist,
        sz = P[m][1] + nz * side * dist;
      const rotY = -H[m] + (side > 0 ? 0 : Math.PI);
      this.world.add(grandstand(len, T, rng, this.standPeople, sx, sz, rotY));
      this.standAreas.push(standArea(`Grandstand ${'ABCD'[this.standAreas.length]}`, len, sx, sz, rotY));
    }

    // Floodlight towers (real light comes from the spot pool, aimed at the track)
    this.towers = [];
    const pole = new THREE.CylinderGeometry(0.3, 0.45, 26, 8);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff6e0 });
    const glowMat = new THREE.SpriteMaterial({ map: radialTexture('rgba(255,240,210,0.85)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const step = Math.max(6, Math.round(90 / sp));
    for (let i = 0, s = 1; i < N; i += step, s = -s) {
      const [x, , z] = off(i, s * (W[i] / 2 + WALL + 3), 0);
      const p = new THREE.Mesh(pole, T.steel);
      p.position.set(x, 13, z);
      p.castShadow = true;
      const head = new THREE.Mesh(new THREE.BoxGeometry(4.5, 2, 0.5), lampMat);
      head.position.set(x, 26.5, z);
      head.rotation.y = -H[i];
      const glow = new THREE.Sprite(glowMat);
      glow.scale.set(18, 18, 1);
      glow.position.set(x, 26.5, z);
      this.world.add(p, head, glow);
      const aim = off(i, -s * W[i] * 0.2, 0);
      this.towers.push({ pos: new THREE.Vector3(x, 26, z), aim: new THREE.Vector3(aim[0], 0, aim[2]) });
    }

    // Distant forest outside the walls (decorative, static)
    this.world.add(forest(track, rng, T));
    this.areas = [...this.standAreas];
    this.seat = { a: -1, u: 0, v: 0 };
    this.rebuildCrowd();
  }

  /** Solid obstacles of a live race: trees that can be hit, crowd fences with spectators behind. */
  setObstacles(ob: Obstacles | null) {
    if (this.swap) {
      this.swap.ob = ob;
      return;
    }
    this.applyObstacles(ob);
  }

  private applyObstacles(ob: Obstacles | null) {
    disposeTree(this.obsGroup);
    this.obsGroup.clear();
    this.treeParts = [];
    this.treeAnim.clear();
    this.zonePeople = [];
    this.ob = ob;
    this.areas = [...this.standAreas];
    if (this.seat.a >= this.areas.length) this.seat.a = -1;
    if (!ob) {
      this.rebuildCrowd();
      return;
    }
    const T = this.T;
    // Trees you can hit
    const parts = treeParts(T, ob.trees.length, this.quality >= 3 ? 2 : 1); // simpler crowns below the top setting
    ob.trees.forEach((t, i) => {
      const list: TreePart[] = [];
      for (const [part, local] of treeLayout(t.kind, t.size)) {
        const set = parts[part];
        list.push({ mesh: set.mesh, index: set.used++, local });
      }
      this.treeParts[i] = list;
      if (ob.down[i]) this.treeAnim.set(i, { shake0: -99, shakeAmp: 0, fall0: -999, dirX: 1, dirZ: 0 });
      this.placeTree(i);
    });
    for (const p of Object.values(parts)) {
      p.mesh.count = p.used;
      p.mesh.instanceMatrix.needsUpdate = true;
      p.mesh.castShadow = this.quality >= 3;
      this.obsGroup.add(p.mesh);
    }
    // Catch fences: ad-board base, chain-link above, posts; concrete terrace with fans behind
    const rng = Rng.fromString(`crowd:${this.track?.seed ?? ''}`);
    const platforms: SeatArea[] = [];
    for (const z of ob.crowdZones) {
      this.areas.push(terraceArea(`Fence terrace ${this.areas.length - this.standAreas.length + 1}`, z.pts, z.nx, z.ny));
      const pts = z.pts;
      // Ad boards face the track (readable from the cars); plain concrete on the crowd side.
      // vstrip's front face points to the left of the polyline direction, so flip the order if needed.
      const dx = pts[1][0] - pts[0][0],
        dz = pts[1][1] - pts[0][1];
      const towardTrack = -dz * -z.nx[0] + dx * -z.ny[0] > 0;
      const trackward = towardTrack ? pts : [...pts].reverse();
      const ads = new THREE.Mesh(vstrip(trackward, 0, 1.0, 9), T.adboard);
      ads.castShadow = true;
      ads.receiveShadow = true;
      const adsBack = new THREE.Mesh(vstrip([...trackward].reverse(), 0, 1.0, 4), T.concreteFront);
      this.obsGroup.add(adsBack);
      const link = new THREE.Mesh(vstrip(pts, 1.0, 4.2, 0.6), T.chainlink); // ~15 cm diamonds
      const back = pts.map((p, i) => [p[0] + z.nx[i] * 12, p[1] + z.ny[i] * 12] as Pt);
      const terrace = new THREE.Mesh(ribbon(pts, back, 0.04), T.concrete);
      terrace.receiveShadow = true;
      const along = polyline(pts, 4);
      const postMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, 4.3, 6), T.steel, Math.max(1, along.length));
      along.forEach(([x, y], i) => postMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 2.15, y)));
      this.obsGroup.add(ads, link, terrace, postMesh);
      // Raised fan platforms behind the standing crowd (above the fence, so the view isn't through the mesh).
      // The fan camera stands on these.
      for (let k = 3; k < pts.length - 3; k += 7) {
        const px = pts[k][0] + z.nx[k] * 8.5,
          pz = pts[k][1] + z.ny[k] * 8.5;
        this.obsGroup.add(platform(px, pz, Math.atan2(z.nx[k], z.ny[k]), T));
        platforms.push(platformArea(px, pz, z.nx[k], z.ny[k]));
      }
      const spots = polyline(pts, 0.8);
      spots.forEach(([x, y], i) => {
        const k = Math.min(z.nx.length - 1, Math.floor((i / spots.length) * z.nx.length));
        const nx = z.nx[k],
          ny = z.ny[k];
        for (let row = 0; row < 4; row++) {
          if (rng.next() < 0.18 + row * 0.08) continue;
          const d = 1.3 + row * 1.0 + rng.next() * 0.4;
          const j = (rng.next() - 0.5) * 0.5;
          this.zonePeople.push({ x: x + nx * d - ny * j, y: 0.04, z: y + ny * d + nx * j, dx: nx, dz: ny, v: Math.floor(rng.next() * VARIANTS), ph: rng.next(), seat: 0 });
        }
      });
    }
    platforms.forEach((a, i) => {
      a.name = `Viewing platform ${i + 1}`;
      this.areas.push(a);
    });
    this.rebuildCrowd();
  }

  private rebuildCrowd() {
    for (const m of [this.nearMesh, this.farMesh]) {
      if (!m) continue;
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this.nearMesh = this.farMesh = null;
    this.fans = [...this.standPeople, ...this.zonePeople];
    const n = this.fans.length;
    if (!n) return;
    this.fanLooks = lookAttributes(this.fans.map((p) => p.v));
    const inst = (g: THREE.InstancedBufferGeometry, cap: number, withLooks: boolean) => {
      const a3 = (name: string) => g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      const a2 = (name: string) => g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage));
      const a1 = (name: string) => g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
      a3('aOffset');
      a2('aDir');
      a1('aVar');
      a1('aPhase');
      a1('aSeat');
      if (withLooks) for (const k of ['aShirt', 'aPants', 'aSkin', 'aHair']) a3(k);
      g.instanceCount = 0;
    };
    const human = humanGeometry();
    const ng = new THREE.InstancedBufferGeometry();
    ng.index = null;
    for (const [k, v] of Object.entries(human.attributes)) ng.setAttribute(k, v);
    ng.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(human.getAttribute('position').count * 3).fill(1), 3));
    inst(ng, Math.min(n, NEAR_FANS), true);
    const card = new THREE.PlaneGeometry(CARD_W, CARD_H).translate(0, CARD_H / 2, 0);
    const fg = new THREE.InstancedBufferGeometry();
    fg.index = card.index;
    fg.setAttribute('position', card.getAttribute('position'));
    fg.setAttribute('uv', card.getAttribute('uv'));
    inst(fg, n, false);
    this.nearMesh = new THREE.Mesh(ng, this.humanMat);
    this.farMesh = new THREE.Mesh(fg, this.cardMat);
    for (const m of [this.nearMesh, this.farMesh]) {
      m.frustumCulled = false;
      this.scene.add(m);
    }
    this.lastSplit.set(1e9, 0, 0);
  }

  /** Fans near the camera become 3D people, the rest stay cards. Re-done as the camera moves. */
  private splitCrowd() {
    const near = this.nearMesh,
      far = this.farMesh,
      looks = this.fanLooks;
    if (!near || !far || !looks) return;
    const cam = this.camera.position;
    if (this.time < this.splitAt && cam.distanceTo(this.lastSplit) < 6) return;
    this.splitAt = this.time + 0.5;
    this.lastSplit.copy(cam);
    const ng = near.geometry as THREE.InstancedBufferGeometry,
      fg = far.geometry as THREE.InstancedBufferGeometry;
    const get = (g: THREE.BufferGeometry, k: string) => (g.getAttribute(k) as THREE.InstancedBufferAttribute).array as Float32Array;
    const nOff = get(ng, 'aOffset'), nDir = get(ng, 'aDir'), nVar = get(ng, 'aVar'), nPh = get(ng, 'aPhase'), nSeat = get(ng, 'aSeat');
    const nShirt = get(ng, 'aShirt'), nPants = get(ng, 'aPants'), nSkin = get(ng, 'aSkin'), nHair = get(ng, 'aHair');
    const fOff = get(fg, 'aOffset'), fDir = get(fg, 'aDir'), fVar = get(fg, 'aVar'), fPh = get(fg, 'aPhase'), fSeat = get(fg, 'aSeat');
    const cap = nVar.length;
    const radius = [25, 35, 50, NEAR_RADIUS][this.quality] ?? NEAR_RADIUS; // fewer full 3D fans on lower settings
    const r2 = radius * radius;
    let ni = 0,
      fi = 0;
    this.fans.forEach((p, i) => {
      const d2 = (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2;
      if (d2 < r2 && ni < cap) {
        nOff[ni * 3] = p.x;
        nOff[ni * 3 + 1] = p.y;
        nOff[ni * 3 + 2] = p.z;
        nDir[ni * 2] = p.dx;
        nDir[ni * 2 + 1] = p.dz;
        nVar[ni] = p.v;
        nPh[ni] = p.ph;
        nSeat[ni] = p.seat;
        for (const [dst, src] of [[nShirt, looks.shirt], [nPants, looks.pants], [nSkin, looks.skin], [nHair, looks.hair]] as const) {
          dst[ni * 3] = src[i * 3];
          dst[ni * 3 + 1] = src[i * 3 + 1];
          dst[ni * 3 + 2] = src[i * 3 + 2];
        }
        ni++;
      } else {
        fOff[fi * 3] = p.x;
        fOff[fi * 3 + 1] = p.y;
        fOff[fi * 3 + 2] = p.z;
        fDir[fi * 2] = p.dx;
        fDir[fi * 2 + 1] = p.dz;
        fVar[fi] = p.v;
        fPh[fi] = p.ph;
        fSeat[fi] = p.seat;
        fi++;
      }
    });
    ng.instanceCount = ni;
    fg.instanceCount = fi;
    for (const g of [ng, fg]) for (const k of Object.keys(g.attributes)) if ((g.getAttribute(k) as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) g.getAttribute(k).needsUpdate = true;
  }

  /** Position a hittable tree, including its shake / fall animation. */
  private placeTree(i: number) {
    const t = this.ob?.trees[i];
    const parts = this.treeParts[i];
    if (!t || !parts) return;
    const a = this.treeAnim.get(i);
    const root = new THREE.Matrix4().makeTranslation(t.x, 0, t.y);
    if (a) {
      const axis = new THREE.Vector3(a.dirZ, 0, -a.dirX).normalize();
      let angle: number;
      if (a.fall0 === -999) angle = Math.PI / 2 - 0.06;
      else if (a.fall0 > -50) {
        const age = this.time - a.fall0;
        const f = Math.min(1, (age / 1.15) ** 2);
        const bounce = age > 1.15 ? Math.sin(Math.min(1, (age - 1.15) * 3) * Math.PI) * 0.06 * Math.max(0, 1 - (age - 1.15)) : 0;
        angle = f * (Math.PI / 2 - 0.06) - bounce;
      } else {
        const s = this.time - a.shake0;
        angle = Math.sin(s * 18) * a.shakeAmp * Math.max(0, 1 - s / 1.1) * 0.12;
      }
      // The tree is pushed the way the car was going: tip over around the horizontal axis.
      root.multiply(new THREE.Matrix4().makeRotationAxis(axis, angle));
    }
    const m = new THREE.Matrix4();
    for (const p of parts) {
      m.multiplyMatrices(root, p.local);
      p.mesh.setMatrixAt(p.index, m);
      p.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ==================================================================== cars
  setCars(entries: { name: string; color: string; skin?: string }[], you: number) {
    // Skins not downloaded yet: race with the default one for now, swap them in when they arrive.
    const missing = [...new Set(entries.map((e) => e.skin ?? DEFAULT_SKIN))].filter((id) => !skinLoaded(id));
    if (missing.length) {
      const token = (this.carsToken = {});
      void Promise.all(missing.map(loadSkin)).then(() => {
        if (this.carsToken === token) this.setCars(entries, you);
      });
    } else this.carsToken = null;
    for (const c of this.cars) {
      c.label?.material.map?.dispose();
      c.label?.material.dispose();
      this.carGroup.remove(c.root);
    }
    this.cars = entries.map((e, i) => {
      const m = racer(e.color, e.skin);
      if (i !== you) {
        m.label = labelSprite(e.name, e.color);
        m.label.position.set(0, m.height + 0.9, 0);
        m.root.add(m.label);
      }
      this.carGroup.add(m.root);
      return m;
    });
    this.snap = true;
  }

  // ==================================================================== race events -> reactions
  onEvent(ev: RaceEvent, cars: CarVisual[]) {
    if (this.swap) return; // the old world is going away
    const c = cars[ev.car];
    const strength = Math.min(1, (ev.v ?? 8) / 20);
    const mine = ev.car === this.focusIdx || ev.other === this.focusIdx;
    if (ev.type === 'tree' && this.ob && ev.obj !== undefined) {
      const t = this.ob.trees[ev.obj];
      if (!t) return;
      const dx = c ? Math.cos(c.h) : 1,
        dz = c ? Math.sin(c.h) : 0;
      if (ev.down) {
        this.ob.down[ev.obj] = true;
        this.treeAnim.set(ev.obj, { shake0: this.time, shakeAmp: 0, fall0: this.time, dirX: dx, dirZ: dz });
      } else if (!this.ob.down[ev.obj]) {
        this.treeAnim.set(ev.obj, { shake0: this.time, shakeAmp: strength + 0.3, fall0: -99, dirX: dx, dirZ: dz });
      }
      for (let k = 0; k < (ev.down ? 70 : 30); k++) this.fx.emit(leafParticle(t.x, 3 + Math.random() * 4, t.y));
      for (let k = 0; k < 14; k++) this.fx.emit(dirtParticle(t.x, 0.5, t.y, 4));
      if (mine) this.shake = Math.max(this.shake, 0.4 + strength);
      this.excite = Math.max(this.excite, 0.35);
    } else if (ev.type === 'fence' && c) {
      // Fans right there jump back and throw their arms up; nobody gets hurt.
      this.cu.uImpacts.value[this.impactSlot].set(c.x, c.y, this.time, 1);
      this.impactSlot = (this.impactSlot + 1) % MAX_IMPACTS;
      for (let k = 0; k < 40; k++) this.sparks.emit(sparkParticle(c.x, 0.8 + Math.random() * 1.5, c.y));
      for (let k = 0; k < 20; k++) this.fx.emit(dirtParticle(c.x, 0.4, c.y, 5));
      if (mine) this.shake = Math.max(this.shake, 0.5 + strength);
      this.excite = Math.max(this.excite, 0.8);
    } else if ((ev.type === 'wall' || ev.type === 'contact') && c) {
      for (let k = 0; k < 25; k++) this.sparks.emit(sparkParticle(c.x, 0.5, c.y));
      if (mine) this.shake = Math.max(this.shake, 0.35);
      this.excite = Math.max(this.excite, 0.3);
    } else if (ev.type === 'overtake') this.excite = Math.max(this.excite, 0.45);
    else if (ev.type === 'finish' || ev.type === 'final_lap') this.excite = 1;
  }

  /** First person from a spectator area: walk (WASD), look (drag), zoom (wheel), or let it follow. */
  private fanCamera(f: CarVisual, dt: number) {
    if (!this.areas.length) return;
    const def = (i: number) => this.areas[i].at(this.areas[i].du, this.areas[i].dv).pos;
    const dist = (i: number) => Math.hypot(def(i).x - f.x, def(i).z - f.y);
    if (this.seat.a < 0 || this.seat.a >= this.areas.length || this.autoSeat) {
      let best = 0;
      for (let i = 1; i < this.areas.length; i++) if (dist(i) < dist(best)) best = i;
      const cur = this.seat.a;
      if (cur < 0 || cur >= this.areas.length || (best !== cur && dist(best) < dist(cur) * 0.55 && dist(cur) > 120)) this.goTo(best);
    }
    const A = this.areas[this.seat.a];
    // walking, relative to where the area faces
    const fwd = (this.walkKeys.has('w') ? 1 : 0) - (this.walkKeys.has('s') ? 1 : 0);
    const side = (this.walkKeys.has('d') ? 1 : 0) - (this.walkKeys.has('a') ? 1 : 0);
    if (fwd || side) {
      this.autoSeat = false;
      const here = A.at(this.seat.u, this.seat.v);
      const right = new THREE.Vector3(-here.face.z, 0, here.face.x);
      const along = A.at(this.seat.u + 0.5, this.seat.v).pos.sub(here.pos);
      const uSign = along.dot(right) >= 0 ? 1 : -1;
      const back = A.at(this.seat.u, this.seat.v + 0.5).pos.sub(here.pos);
      const vSign = back.dot(here.face) <= 0 ? 1 : -1; // +v moves away from the track
      const speed = A.kind === 'stand' ? 2.2 : 3.2;
      this.seat.u = THREE.MathUtils.clamp(this.seat.u + side * uSign * speed * dt, A.u0, A.u1);
      this.seat.v = THREE.MathUtils.clamp(this.seat.v - fwd * vSign * (A.kind === 'stand' ? 2.5 : speed) * dt, A.v0, A.v1);
    }
    const { pos, face } = A.at(this.seat.u, this.seat.v);
    if (this.snap) this.eye.copy(pos);
    else this.eye.lerp(pos, 1 - Math.exp(-dt * 8));
    const sway = Math.sin(this.time * 1.3) * 0.02;
    this.camera.position.set(this.eye.x + sway, this.eye.y + Math.sin(this.time * 0.9) * 0.015, this.eye.z);
    if (this.shake > 0.01) {
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.15;
      this.shake *= Math.exp(-dt * 5);
    }
    const look = new THREE.Vector3(f.x, 0.9, f.y);
    if (this.follow) {
      if (this.snap) this.camLook.copy(look);
      else this.camLook.lerp(look, 1 - Math.exp(-dt * 7)); // head turning, a touch behind the car
    } else {
      const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
      this.camLook.copy(this.camera.position).add(dir.multiplyScalar(10));
    }
    if (this.snap && !this.follow) this.setYawFrom(face);
    this.snap = false;
    this.camera.lookAt(this.camLook);
    const d = this.camera.position.distanceTo(look);
    const fov = this.userFov || THREE.MathUtils.clamp(74 - d * 0.16, 36, 70);
    if (Math.abs(fov - this.camera.fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 5);
      this.camera.updateProjectionMatrix();
    }
  }

  private goTo(a: number, u?: number, v?: number) {
    const A = this.areas[a];
    if (!A) return;
    this.seat = { a, u: u ?? A.du, v: v ?? A.dv };
    this.snap = true;
  }

  private setYawFrom(dir: THREE.Vector3) {
    this.yaw = Math.atan2(dir.x, dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  }

  /** Mouse/touch drag = look around, wheel = zoom, WASD/arrows = walk, F = follow the car. */
  private bindFanControls() {
    const el = this.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      if (this.camMode !== 'fan') return;
      this.dragging = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging || this.camMode !== 'fan') return;
      const dx = e.clientX - this.dragging.x,
        dy = e.clientY - this.dragging.y;
      if (this.follow && Math.hypot(dx, dy) < 4) return;
      if (this.follow) {
        this.follow = false;
        this.setYawFrom(new THREE.Vector3().subVectors(this.camLook, this.camera.position).normalize());
      }
      this.dragging = { x: e.clientX, y: e.clientY };
      const k = (this.camera.fov / 70) * 0.005;
      this.yaw -= dx * k;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * k, -1.2, 1.2);
    });
    const end = () => (this.dragging = null);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'wheel',
      (e) => {
        if (this.camMode !== 'fan') return;
        e.preventDefault();
        this.userFov = THREE.MathUtils.clamp((this.userFov || this.camera.fov) * (e.deltaY > 0 ? 1.1 : 0.9), 14, 85);
      },
      { passive: false },
    );
    const map: Record<string, string> = { KeyW: 'w', ArrowUp: 'w', KeyS: 's', ArrowDown: 's', KeyA: 'a', ArrowLeft: 'a', KeyD: 'd', ArrowRight: 'd' };
    const typing = (e: KeyboardEvent) => ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName);
    window.addEventListener('keydown', (e) => {
      if (this.camMode !== 'fan' || !this.visible || typing(e)) return;
      const k = map[e.code];
      if (k) {
        this.walkKeys.add(k);
        e.preventDefault();
      }
      if (e.code === 'KeyF') this.setFollow(!this.follow);
    });
    window.addEventListener('keyup', (e) => {
      const k = map[e.code];
      if (k) this.walkKeys.delete(k);
    });
    window.addEventListener('blur', () => this.walkKeys.clear());
  }

  // ---------------------------------------------------------------- seat picking (used by the UI)
  /** Fan camera: go to the next spectator area (wraps). */
  nextFanSpot() {
    if (!this.areas.length) return;
    this.autoSeat = false;
    this.goTo((this.seat.a + 1) % this.areas.length);
  }

  seatAreas(): readonly SeatArea[] {
    return this.areas;
  }

  /** Pick an area (and optionally a spot in it); -1 = automatic (nearest the action). */
  chooseSeat(a: number, u?: number, v?: number) {
    if (a < 0) {
      this.autoSeat = true;
      this.seat.a = -1;
    } else {
      this.autoSeat = false;
      this.goTo(a, u, v);
    }
    this.follow = true;
    this.userFov = 0;
  }

  setFollow(on: boolean) {
    this.follow = on;
    if (on) this.userFov = 0;
    else this.setYawFrom(new THREE.Vector3().subVectors(this.camLook, this.camera.position).normalize());
  }

  fanStatus(): FanStatus {
    const A = this.areas[this.seat.a];
    let detail = '';
    if (A?.kind === 'stand') detail = `Row ${Math.round(this.seat.v) + 1}, seat ${Math.round(this.seat.u - A.u0) + 1}`;
    else if (A?.kind === 'terrace') detail = this.seat.v < 2.2 ? 'Front row' : `${Math.round(this.seat.v)} m behind the fence`;
    else if (A) detail = 'Above the crowd';
    return { area: A?.name ?? 'Finding a spot…', detail, follow: this.follow, auto: this.autoSeat };
  }

  trackOutline(): Pt[] {
    return (this.track?.points ?? []).map((p) => [p[0], p[1]] as Pt);
  }

  setCamMode(m: 'chase' | 'fan') {
    if (m === this.camMode) return;
    this.camMode = m;
    this.walkKeys.clear();
    this.follow = true;
    this.userFov = 0;
    this.snap = true;
  }

  /** Metres from the camera to the followed car (for engine volume in the fan view). */
  distanceTo(c: CarVisual | undefined): number {
    return c ? Math.hypot(c.x - this.camera.position.x, c.y - this.camera.position.z) : 0;
  }

  /** Replays/seeking: make the fallen-tree state match `down` instantly. */
  syncDown(down: boolean[]) {
    if (this.swap) {
      const ob = this.swap.ob;
      if (ob) down.forEach((d, i) => (ob.down[i] = d));
      return;
    }
    if (!this.ob) return;
    down.forEach((d, i) => {
      if (d === this.ob!.down[i]) return;
      this.ob!.down[i] = d;
      if (d) this.treeAnim.set(i, { shake0: -99, shakeAmp: 0, fall0: -999, dirX: 1, dirZ: 0 });
      else this.treeAnim.delete(i);
      this.placeTree(i);
    });
  }

  /**
   * Compile every shader the scene needs before it is drawn, in the background (parallel compile), so
   * the first frames don't freeze. Compiles the variants actually used: drawn into the composer's
   * render target (linear colour), hidden things included (near fans, fallen trees), plus a car.
   */
  async warmUp(): Promise<void> {
    const gl = this.gl;
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    const extra = racer('#ffffff').root;
    if (extra) this.scene.add(extra);
    const prev = gl.getRenderTarget();
    gl.setRenderTarget(this.composer.renderTarget1);
    let compiling: Promise<unknown> = Promise.resolve();
    try {
      compiling = gl.compileAsync(this.scene, this.camera); // the programs are created right here, synchronously
    } catch {
      /* compile on first use instead */
    }
    gl.setRenderTarget(prev);
    for (const o of hidden) o.visible = false;
    if (extra) this.scene.remove(extra);
    await compiling.catch(() => {});
    if (this.passesWarm) return;
    // Post-processing isn't part of the scene: compile the bloom shaders the same way...
    const fx = new THREE.Scene();
    const quad = new THREE.PlaneGeometry(2, 2);
    const b = this.bloom;
    for (const m of [b.materialHighPassFilter, ...b.separableBlurMaterials, b.compositeMaterial, b.blendMaterial]) fx.add(new THREE.Mesh(quad, m));
    gl.setRenderTarget(this.composer.renderTarget1);
    let passes: Promise<unknown> = Promise.resolve();
    try {
      passes = gl.compileAsync(fx, this.camera);
    } catch {
      /* first use instead */
    }
    gl.setRenderTarget(prev);
    await passes.catch(() => {});
    quad.dispose();
    // ...then draw one frame while the view is still hidden: builds the output pass and uploads the
    // textures now, during loading, rather than on the first visible frame.
    if (!this.visible) this.composer.render(0);
    this.passesWarm = true;
  }
  private passesWarm = false;

  /** 0..1: how close the followed car is to a crowd (drives the crowd sound). */
  crowdNear(cars: CarVisual[], focus: number): number {
    const f = cars[focus];
    if (!f) return 0;
    let best = Infinity;
    for (const p of this.zonePeople) {
      const d = (p.x - f.x) ** 2 + (p.z - f.y) ** 2;
      if (d < best) best = d;
      if (best < 100) break;
    }
    return Math.max(0, 1 - Math.sqrt(best) / 60);
  }

  // ==================================================================== frame
  render(cars: CarVisual[], focus: number, dt: number) {
    if (!this.visible || this.swap) return; // mid-swap: the dark layer covers the last frame
    // Behind the full-screen lobby cards nobody sees the difference: draw every other frame.
    const bc = document.body.classList;
    if ((bc.contains('in-lobby') || bc.contains('league-lobby')) && this.swapFrames === 0) {
      this.heldDt += dt;
      if ((this.frameNo++ & 1) === 0) return;
      dt = this.heldDt; // the skipped frames' time, so animations keep pace
      this.heldDt = 0;
    }
    if (this.swapFrames > 0 && --this.swapFrames === 0) {
      this.covering = false;
      this.calmUntil = performance.now() + 2000;
      this.fade.classList.remove('on');
    }
    this.time += dt;
    this.adaptQuality();
    this.focusIdx = focus;
    this.excite = Math.max(0, this.excite - dt * 0.18);
    const cam = this.camera.position;

    // A car with no position yet (data still loading) is skipped, so it can't poison the camera.
    const ok = (c: CarVisual | undefined): c is CarVisual => !!c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.h) && Number.isFinite(c.speed);
    cars.forEach((c, i) => {
      const m = this.cars[i];
      if (!m || !ok(c)) return;
      m.root.position.set(c.x, 0, c.y);
      m.root.rotation.y = -c.h;
      // body pitch under braking/acceleration, roll in corners
      let dh = c.h - m.prevH;
      dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI;
      const yawRate = dt > 0 ? dh / dt : 0;
      const accel = dt > 0 ? (c.speed - m.prevSpeed) / dt : 0;
      m.prevH = c.h;
      m.prevSpeed = c.speed;
      m.pitch += (THREE.MathUtils.clamp(-accel * 0.004, -0.05, 0.05) - m.pitch) * Math.min(1, dt * 6);
      m.roll += (THREE.MathUtils.clamp(yawRate * c.speed * 0.0025, -0.06, 0.06) - m.roll) * Math.min(1, dt * 6);
      m.body.rotation.set(m.roll, 0, m.pitch, 'YXZ');
      m.spin += (c.speed * dt) / m.wheelR;
      m.animate?.(this.time, dt, c.speed, yawRate, accel);
      const steer = THREE.MathUtils.clamp(yawRate * 0.35, -0.45, 0.45);
      for (const w of m.wheels) w.rotation.x = m.spin;
      for (const w of m.front) w.rotation.y = steer;
      if (m.tail) m.tail.emissiveIntensity = c.flags & FLAG.braking ? 4 : 0.8;
      const d = Math.hypot(c.x - cam.x, c.y - cam.z);
      if (m.label) m.label.visible = (this.camMode === 'fan' || i !== focus) && d > 6 && d < 320;
      // tyre smoke / dirt + skid marks when sliding
      const off = (c.flags & FLAG.offTrack) !== 0;
      if (d < 140 && (c.slip > 3 || (off && c.speed > 8))) {
        const fx = Math.cos(c.h),
          fz = Math.sin(c.h);
        for (const s of [-1, 1]) {
          const wx = c.x - fx * 1.3 - fz * 0.8 * s,
            wz = c.y - fz * 1.3 + fx * 0.8 * s;
          if (Math.random() < (off ? 0.5 : 0.35)) this.fx.emit(off ? dirtParticle(wx, 0.3, wz, 2) : smokeParticle(wx, 0.3, wz));
          if (!off) {
            const k = s < 0 ? 0 : 1;
            const prev = m.skid[k];
            if (prev && Math.hypot(prev[0] - wx, prev[1] - wz) < 3) this.skids.add(prev[0], prev[1], wx, wz, Math.min(1, (c.slip - 2) / 6));
            m.skid[k] = [wx, wz];
          }
        }
      } else m.skid = [null, null];
      if (c.flags & FLAG.stopped && !(c.flags & FLAG.finished) && Math.random() < 0.3) this.fx.emit(smokeParticle(c.x + Math.cos(c.h) * 2, 1, c.y + Math.sin(c.h) * 2, true));
    });

    // Camera: chase (+ shake on impacts) or first person from the crowd
    const f = ok(cars[focus]) ? cars[focus] : undefined;
    if (!Number.isFinite(dt)) dt = 0;
    // Never stay stuck: a bad camera value would make every later frame black, so start the camera over.
    if (![this.camPos.x, this.camPos.y, this.camPos.z, this.camLook.x, this.camLook.y, this.camLook.z].every(Number.isFinite)) {
      this.camPos.set(0, 0, 0);
      this.camLook.set(0, 0, 0);
      this.snap = true;
    }
    if (f && this.camMode === 'fan' && this.areas.length) {
      this.fanCamera(f, dt);
      this.moon.position.set(f.x - 60, 120, f.y - 40);
      this.moon.target.position.set(f.x, 0, f.y);
      this.headlight.intensity = 0;
    } else if (f) {
      this.headlight.intensity = 220;
      const dx = Math.cos(f.h),
        dz = Math.sin(f.h);
      const back = 8.8 + Math.min(3, f.speed * 0.04);
      const want = new THREE.Vector3(f.x - dx * back, 4.4 + Math.min(0.8, f.speed * 0.01), f.y - dz * back); // high enough to see the rider over the engine
      const look = new THREE.Vector3(f.x + dx * 8, 1.6, f.y + dz * 8);
      if (this.snap) {
        this.camPos.copy(want);
        this.camLook.copy(look);
        this.snap = false;
      } else {
        this.camPos.lerp(want, 1 - Math.exp(-dt * 6));
        this.camLook.lerp(look, 1 - Math.exp(-dt * 11));
      }
      this.camera.position.copy(this.camPos);
      if (this.shake > 0.01) {
        const s = this.shake * 0.35;
        this.camera.position.x += (Math.random() - 0.5) * s;
        this.camera.position.y += (Math.random() - 0.5) * s;
        this.camera.position.z += (Math.random() - 0.5) * s;
        this.shake *= Math.exp(-dt * 5);
      }
      this.camera.lookAt(this.camLook);
      const fov = 58 + Math.min(16, f.speed * 0.24);
      if (Math.abs(fov - this.camera.fov) > 0.05) {
        this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 4);
        this.camera.updateProjectionMatrix();
      }
      // Moon shadow follows the action; headlight on the followed car
      this.moon.position.set(f.x - 60, 120, f.y - 40);
      this.moon.target.position.set(f.x, 0, f.y);
      this.headlight.position.set(f.x + dx * 2.3, 0.8, f.y + dz * 2.3);
      this.headlight.target.position.set(f.x + dx * 30, 0, f.y + dz * 30);
    } else if (this.track) this.flyover(dt);

    // Floodlights: the real spot lights go to the towers nearest the camera
    if (this.towers.length) {
      const near = this.towers
        .map((t, i) => [i, (t.pos.x - cam.x) ** 2 + (t.pos.z - cam.z) ** 2] as const)
        .sort((a, b) => a[1] - b[1])
        .slice(0, this.spots.length);
      near.forEach(([i], k) => {
        this.spots[k].position.copy(this.towers[i].pos);
        this.spots[k].target.position.copy(this.towers[i].aim);
      });
    }

    // Trees: shakes settle back upright, falls play out
    for (const [i, a] of this.treeAnim) {
      if (a.fall0 === -999) continue;
      if (a.fall0 > -50) {
        if (this.time - a.fall0 < 2.5) this.placeTree(i);
      } else if (this.time - a.shake0 < 1.2) this.placeTree(i);
      else {
        this.treeAnim.delete(i);
        this.placeTree(i);
      }
    }

    // Crowd
    const u = this.cu;
    u.uTime.value = this.time;
    u.uExcite.value = this.excite;
    this.splitCrowd();
    const cu = u.uCars.value;
    for (let i = 0; i < MAX_CARS_UNIFORM; i++) {
      const c = cars[i];
      if (c) cu[i].set(c.x, c.y, Math.min(1, c.speed / 30));
      else cu[i].set(1e6, 1e6, 0);
    }

    this.fx.update(dt);
    this.sparks.update(dt);
    if (!this.gl.shadowMap.autoUpdate && Math.floor(this.time * 60) % this.shadowEvery === 0) this.gl.shadowMap.needsUpdate = true;
    this.composer.render(dt);
  }

  /** No car to follow (lobby, Track Lab): a drone glides around the circuit, drifting in and out. */
  private flyover(dt: number) {
    const tr = this.track!;
    const P = tr.points,
      N = P.length;
    this.tourS += dt * 16;
    const at = (s: number): Pt => {
      const k = ((((s / tr.length) * N) % N) + N) % N;
      const i = Math.floor(k),
        j = (i + 1) % N,
        a = k - i;
      return [P[i][0] + (P[j][0] - P[i][0]) * a, P[i][1] + (P[j][1] - P[i][1]) * a];
    };
    const [x, z] = at(this.tourS),
      [lx, lz] = at(this.tourS + 70);
    const d = Math.hypot(lx - x, lz - z) || 1;
    const side = 22 * Math.sin(this.time * 0.06);
    const want = new THREE.Vector3(x - ((lz - z) / d) * side, 20 + 8 * Math.sin(this.time * 0.09), z + ((lx - x) / d) * side);
    const look = new THREE.Vector3(lx, 0, lz);
    if (this.snap) {
      this.camPos.copy(want);
      this.camLook.copy(look);
      this.snap = false;
    } else {
      this.camPos.lerp(want, 1 - Math.exp(-dt * 2));
      this.camLook.lerp(look, 1 - Math.exp(-dt * 2));
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    if (Math.abs(this.camera.fov - 55) > 0.05) {
      this.camera.fov = 55;
      this.camera.updateProjectionMatrix();
    }
    this.headlight.intensity = 0;
    this.moon.position.set(x - 60, 120, z - 40);
    this.moon.target.position.set(x, 0, z);
  }
}

// ====================================================================== textures + materials

function loadTextures(gl: THREE.WebGLRenderer) {
  const tl = new THREE.TextureLoader();
  const aniso = Math.min(8, gl.capabilities.getMaxAnisotropy());
  const tex = (p: string, srgb: boolean, rx = 1, ry = 1) => {
    const t = tl.load(ASSET(`tex/${p}`));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    t.repeat.set(rx, ry);
    return t;
  };
  const grassRep = 5000 / 14;
  const adTex = adTexture();
  const mats = {
    grass: new THREE.MeshStandardMaterial({
      map: tex('aerial_grass_rock_diff.jpg', true, grassRep, grassRep),
      normalMap: tex('aerial_grass_rock_nor.jpg', false, grassRep, grassRep),
      color: 0x7f9a6a,
      roughness: 1,
    }),
    asphalt: new THREE.MeshStandardMaterial({
      map: tex('asphalt_02_diff.jpg', true),
      normalMap: tex('asphalt_02_nor.jpg', false),
      roughnessMap: tex('asphalt_02_rough.jpg', false),
      color: 0x5e6066,
      roughness: 0.9,
      normalScale: new THREE.Vector2(0.8, 0.8),
    }),
    bark: new THREE.MeshStandardMaterial({ map: tex('pine_bark_diff.jpg', true, 1, 2), normalMap: tex('pine_bark_nor.jpg', false, 1, 2), roughness: 1 }),
    leaf: new THREE.MeshStandardMaterial({ map: leafTexture(false), roughness: 0.85 }),
    needle: new THREE.MeshStandardMaterial({ map: leafTexture(true), roughness: 0.9, side: THREE.DoubleSide }),
    paint: new THREE.MeshStandardMaterial({ color: 0xb9bdc2, roughness: 0.6 }),
    kerb: new THREE.MeshStandardMaterial({ map: stripeTexture('#c9cdd2', '#b0101f'), roughness: 0.6 }),
    gravel: new THREE.MeshStandardMaterial({ map: gravelTexture(), roughness: 1 }),
    armco: new THREE.MeshStandardMaterial({ color: 0xb9c1c9, metalness: 0.85, roughness: 0.35, side: THREE.DoubleSide }),
    concrete: new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.95, side: THREE.DoubleSide }),
    steel: new THREE.MeshStandardMaterial({ color: 0x6d7682, metalness: 0.7, roughness: 0.45 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x2a3446, roughness: 0.8 }),
    roof: new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 0.5, roughness: 0.4, side: THREE.DoubleSide }),
    adboard: new THREE.MeshStandardMaterial({ map: adTex, emissive: 0xffffff, emissiveMap: adTex, emissiveIntensity: 0.35, roughness: 0.6 }),
    concreteFront: new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.95 }),
    chainlink: new THREE.MeshStandardMaterial({ map: chainlinkTexture(), alphaTest: 0.35, metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide }),
  };
  for (const m of Object.values(mats)) sharedMats.add(m);
  return mats;
}
type Mats = ReturnType<typeof loadTextures>;

function withShadow<T extends THREE.Mesh>(m: T, cast = true): T {
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}

// ====================================================================== geometry helpers

/** Ribbon along the centerline. pt(i, 0|1) = the two edge points (0 = left); u(i, k) = optional U. */
function strip(idxs: number[], pt: (i: number, k: 0 | 1) => P3, vLen: number, spacing: number, u?: (i: number, k: 0 | 1) => number): THREE.BufferGeometry {
  const pos: number[] = [],
    uv: number[] = [],
    ind: number[] = [];
  idxs.forEach((i, j) => {
    pos.push(...pt(i, 0), ...pt(i, 1));
    const v = (j * spacing) / vLen;
    uv.push(u ? u(i, 0) : 0, v, u ? u(i, 1) : 1, v);
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

/** Vertical wall along a polyline from height y0 to y1; U runs along (uLen m per repeat), V up. */
function vstrip(pts: Pt[], y0: number, y1: number, uLen: number): THREE.BufferGeometry {
  const pos: number[] = [],
    uv: number[] = [],
    ind: number[] = [];
  let dist = 0;
  pts.forEach((p, j) => {
    if (j > 0) dist += Math.hypot(p[0] - pts[j - 1][0], p[1] - pts[j - 1][1]);
    pos.push(p[0], y0, p[1], p[0], y1, p[1]);
    uv.push(dist / uLen, 0, dist / uLen, 1);
    if (j > 0) {
      const q = (j - 1) * 2;
      ind.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(ind);
  g.computeVertexNormals();
  return g;
}

/** Flat ribbon between two polylines of equal length, double-sided so winding doesn't matter. */
function ribbon(a: Pt[], b: Pt[], y: number): THREE.BufferGeometry {
  const pos: number[] = [],
    uv: number[] = [],
    ind: number[] = [];
  let dist = 0;
  a.forEach((p, j) => {
    if (j > 0) dist += Math.hypot(p[0] - a[j - 1][0], p[1] - a[j - 1][1]);
    pos.push(p[0], y, p[1], b[j][0], y, b[j][1]);
    uv.push(dist / 6, 0, dist / 6, 2);
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
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0); // lit from above either way
  return g;
}

/** Evenly spaced points along a polyline. */
function polyline(pts: Pt[], every: number): Pt[] {
  const out: Pt[] = [];
  let carry = 0;
  for (let j = 1; j < pts.length; j++) {
    const [ax, ay] = pts[j - 1],
      [bx, by] = pts[j];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    let d = carry;
    for (; d < len; d += every) out.push([ax + ((bx - ax) * d) / len, ay + ((by - ay) * d) / len]);
    carry = d - len;
  }
  return out;
}

function gantry(p: Pt, h: number, w: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x1b2028, metalness: 0.6, roughness: 0.45 });
  const half = w / 2 + 3;
  for (const s of [-1, 1]) {
    const leg = withShadow(new THREE.Mesh(new THREE.BoxGeometry(0.9, 9, 0.9), mat));
    leg.position.set(0, 4.5, s * half);
    g.add(leg);
  }
  const beam = withShadow(new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.6, half * 2 + 1), mat));
  beam.position.set(0, 9.2, 0);
  const bannerTex = bannerTexture();
  const bannerMat = new THREE.MeshStandardMaterial({ map: bannerTex, emissive: 0xffffff, emissiveMap: bannerTex, emissiveIntensity: 0.9, side: THREE.DoubleSide });
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(half * 1.6, 2.1), bannerMat);
  banner.position.set(-0.65, 9.2, 0);
  banner.rotation.y = -Math.PI / 2;
  const banner2 = banner.clone();
  banner2.position.x = 0.65;
  banner2.rotation.y = Math.PI / 2;
  const lightMat = new THREE.MeshBasicMaterial({ color: 0x330408 });
  for (let i = 0; i < 5; i++) {
    const l = new THREE.Mesh(new THREE.CircleGeometry(0.3, 16), lightMat);
    l.position.set(-0.66, 7.6, (i - 2) * 0.8);
    l.rotation.y = -Math.PI / 2;
    g.add(l);
  }
  g.add(beam, banner, banner2);
  g.position.set(p[0], 0, p[1]);
  g.rotation.y = -h;
  return g;
}

const PLATFORM_H = 3.4;

/** Steel scaffold viewing platform (3 x 3 m deck, railings) with a few fans on it. */
function platform(x: number, z: number, rotY: number, T: Mats): THREE.Group {
  const g = new THREE.Group();
  const deck = withShadow(new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.15, 3.2), T.steel));
  deck.position.y = PLATFORM_H;
  g.add(deck);
  const leg = new THREE.CylinderGeometry(0.07, 0.07, PLATFORM_H, 6);
  for (const a of [-1.5, 1.5])
    for (const b of [-1.5, 1.5]) {
      const l = withShadow(new THREE.Mesh(leg, T.steel));
      l.position.set(a, PLATFORM_H / 2, b);
      g.add(l);
    }
  const rail = new THREE.BoxGeometry(3.2, 0.05, 0.05);
  for (const s of [-1.55, 1.55]) {
    const r = new THREE.Mesh(rail, T.steel);
    r.position.set(0, PLATFORM_H + 1.0, s);
    const r2 = r.clone();
    r2.rotation.y = Math.PI / 2;
    r2.position.set(s, PLATFORM_H + 1.0, 0);
    g.add(r, r2);
  }
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  return g;
}

/** Grandstand seats: u along the row (m), v = row (0 = front, 9 = back). Eyes of a seated fan. */
function standArea(name: string, len: number, x: number, z: number, rotY: number): SeatArea {
  const m = new THREE.Matrix4().makeRotationY(rotY).setPosition(x, 0, z);
  const face = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
  const depth = 10 * 0.85;
  const corner = (u: number, w: number) => {
    const v = new THREE.Vector3(u, 0, w).applyMatrix4(m);
    return [v.x, v.z] as Pt;
  };
  return {
    name,
    kind: 'stand',
    u0: -len / 2 + 0.6,
    u1: len / 2 - 0.6,
    v0: 0,
    v1: 9,
    du: 0,
    dv: 6,
    at: (u, v) => {
      const row = THREE.MathUtils.clamp(v, 0, 9);
      // eye of someone sitting on the bench of this row (steps are 0.5 m)
      const y = 0.5 * (Math.round(row) + 1) + 0.42 + 0.78;
      const pos = new THREE.Vector3(u, y, -depth / 2 + 0.85 * row + 0.42).applyMatrix4(m);
      return { pos, face: face.clone() };
    },
    outline: [corner(-len / 2, -depth / 2), corner(len / 2, -depth / 2), corner(len / 2, depth / 2), corner(-len / 2, depth / 2)],
  };
}

/** Standing terrace behind a catch fence: u = metres along the fence, v = metres behind it. */
function terraceArea(name: string, pts: Pt[], nx: number[], ny: number[]): SeatArea {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const sample = (u: number) => {
    let i = 1;
    while (i < pts.length - 1 && cum[i] < u) i++;
    const f = THREE.MathUtils.clamp((u - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]), 0, 1);
    return {
      x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
      z: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f,
      nx: nx[i - 1] + (nx[i] - nx[i - 1]) * f,
      nz: ny[i - 1] + (ny[i] - ny[i - 1]) * f,
    };
  };
  const back = pts.map((p, i) => [p[0] + nx[i] * 12, p[1] + ny[i] * 12] as Pt).reverse();
  return {
    name,
    kind: 'terrace',
    u0: 3,
    u1: Math.max(3, total - 3),
    v0: 1.0,
    v1: 11,
    du: total / 2,
    dv: 1.3,
    at: (u, v) => {
      const s = sample(u);
      return { pos: new THREE.Vector3(s.x + s.nx * v, 1.72, s.z + s.nz * v), face: new THREE.Vector3(-s.nx, 0, -s.nz) };
    },
    outline: [...pts, ...back],
  };
}

/** Raised viewing platform deck (3 x 3 m): u across, v front (-) to back (+). */
function platformArea(x: number, z: number, nx: number, nz: number): SeatArea {
  const tx = -nz,
    tz = nx;
  const c = (u: number, v: number) => [x + tx * u + nx * v, z + tz * u + nz * v] as Pt;
  return {
    name: 'Viewing platform',
    kind: 'platform',
    u0: -1.2,
    u1: 1.2,
    v0: -1.2,
    v1: 1.2,
    du: 0,
    dv: -0.9,
    at: (u, v) => ({ pos: new THREE.Vector3(x + tx * u + nx * v, PLATFORM_H + 1.7, z + tz * u + nz * v), face: new THREE.Vector3(-nx, 0, -nz) }),
    outline: [c(-1.6, -1.6), c(1.6, -1.6), c(1.6, 1.6), c(-1.6, 1.6)],
  };
}

/** Covered grandstand facing local -z, rows rising away from the track, seated fans on every row. */
function grandstand(len: number, T: Mats, rng: Rng, people: Person[], x: number, z: number, rotY: number): THREE.Group {
  const g = new THREE.Group();
  const rows = 10,
    rowD = 0.85,
    rowH = 0.5;
  const depth = rows * rowD;
  for (let r = 0; r < rows; r++) {
    const stepM = withShadow(new THREE.Mesh(new THREE.BoxGeometry(len, rowH * (r + 1), rowD), T.concrete), r === rows - 1);
    stepM.position.set(0, (rowH * (r + 1)) / 2, -depth / 2 + rowD * (r + 0.5));
    const seats = new THREE.Mesh(new THREE.BoxGeometry(len, 0.42, 0.42), T.seat);
    seats.position.set(0, rowH * (r + 1) + 0.21, -depth / 2 + rowD * r + 0.3);
    g.add(stepM, seats);
  }
  const backH = rowH * rows + 4;
  const back = withShadow(new THREE.Mesh(new THREE.BoxGeometry(len, backH, 0.4), T.concrete));
  back.position.set(0, backH / 2, depth / 2 + 0.2);
  const roof = withShadow(new THREE.Mesh(new THREE.BoxGeometry(len + 2, 0.25, depth + 3), T.roof));
  roof.position.set(0, backH + 0.2, -0.8);
  roof.rotation.x = -0.06;
  g.add(back, roof);
  for (let c = -len / 2; c <= len / 2 + 0.1; c += Math.max(10, len / 8)) {
    const col = withShadow(new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, backH + 0.2, 8), T.steel));
    col.position.set(c, (backH + 0.2) / 2, depth / 2 - 0.4);
    g.add(col);
  }
  const lights = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0xfff4dc }));
  lights.position.set(0, backH, -depth / 2 - 2);
  g.add(lights);
  const sTex = screenTexture();
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(14, 7), new THREE.MeshStandardMaterial({ map: sTex, emissive: 0xffffff, emissiveMap: sTex, emissiveIntensity: 0.8, side: THREE.DoubleSide }));
  screen.position.set(len * 0.28, backH + 5, 0);
  screen.rotation.y = Math.PI;
  g.add(screen);
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  g.updateMatrixWorld(true);
  // seated fans (world positions)
  const v = new THREE.Vector3();
  const away = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
  for (let r = 0; r < rows; r++)
    for (let s = -len / 2 + 0.4; s < len / 2; s += 0.62) {
      if (rng.next() < 0.22) continue;
      v.set(s + (rng.next() - 0.5) * 0.12, rowH * (r + 1), -depth / 2 + rowD * r + 0.42).applyMatrix4(g.matrixWorld);
      people.push({ x: v.x, y: v.y, z: v.z, dx: away.x, dz: away.z, v: Math.floor(rng.next() * VARIANTS), ph: rng.next(), seat: 1 });
    }
  return g;
}

/** Instanced tree parts: trunk, broadleaf crown blobs, pine cones. */
function treeParts(T: Mats, n: number, detail = 2) {
  const crown = new THREE.IcosahedronGeometry(1, detail);
  jitter(crown, 0.22, 7);
  const cone = new THREE.ConeGeometry(1, 1, 10, 3, true);
  jitter(cone, 0.08, 11);
  const trunk = new THREE.CylinderGeometry(0.62, 1, 1, 8).translate(0, 0.5, 0);
  const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, count: number) => {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
    mesh.name = 'treepart'; // its shadow is switched off on lower graphics settings
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return { mesh, used: 0 };
  };
  return { trunk: mk(trunk, T.bark, n), crown: mk(crown, T.leaf, n * 3), cone: mk(cone, T.needle, n * 3) };
}

/** Parts of one tree as [part, local matrix]. kind 0 = broadleaf, 1 = pine. */
function treeLayout(kind: 0 | 1, s: number): ['trunk' | 'crown' | 'cone', THREE.Matrix4][] {
  const M = (x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
  if (kind === 0)
    return [
      ['trunk', M(0, 0, 0, 0.32 * s, 4.2 * s, 0.32 * s)],
      ['crown', M(0, 5.0 * s, 0, 2.7 * s, 2.3 * s, 2.7 * s)],
      ['crown', M(1.0 * s, 6.0 * s, 0.5 * s, 2.0 * s, 1.8 * s, 2.0 * s)],
      ['crown', M(-0.8 * s, 6.5 * s, -0.6 * s, 1.8 * s, 1.6 * s, 1.8 * s)],
    ];
  return [
    ['trunk', M(0, 0, 0, 0.26 * s, 3.5 * s, 0.26 * s)],
    ['cone', M(0, 4.2 * s, 0, 2.8 * s, 5 * s, 2.8 * s)],
    ['cone', M(0, 6.6 * s, 0, 2.1 * s, 4 * s, 2.1 * s)],
    ['cone', M(0, 8.6 * s, 0, 1.4 * s, 3 * s, 1.4 * s)],
  ];
}

/** Decorative forest outside the walls: same tree shapes, never hit. */
function forest(track: Track, rng: Rng, T: Mats): THREE.Group {
  const g = new THREE.Group();
  const b = track.bounds;
  const pts = track.points.filter((_, i) => i % 2 === 0);
  const minD = Math.max(...track.widths) / 2 + WALL + 10;
  const spots: [number, number, number, 0 | 1][] = [];
  for (let k = 0; k < 5000 && spots.length < 700; k++) {
    const x = b.minX - 280 + rng.next() * (b.maxX - b.minX + 560);
    const z = b.minY - 280 + rng.next() * (b.maxY - b.minY + 560);
    let best = Infinity;
    for (const p of pts) {
      const d = (p[0] - x) ** 2 + (p[1] - z) ** 2;
      if (d < best) best = d;
    }
    if (best > minD * minD && best < 320 * 320) spots.push([x, z, 0.9 + rng.next() * 0.9, rng.next() < 0.45 ? 1 : 0]);
  }
  const parts = treeParts(T, spots.length, 1);
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  for (const [x, z, s, kind] of spots) {
    const root = new THREE.Matrix4().makeRotationY(rng.next() * 6.28).setPosition(x, 0, z);
    color.setHSL(0.28 + rng.next() * 0.06, 0.35, 0.55 + rng.next() * 0.25);
    for (const [part, local] of treeLayout(kind, s)) {
      const p = parts[part];
      m.multiplyMatrices(root, local);
      p.mesh.setMatrixAt(p.used, m);
      if (part !== 'trunk') p.mesh.setColorAt(p.used, color);
      p.used++;
    }
  }
  for (const p of Object.values(parts)) {
    p.mesh.count = p.used;
    p.mesh.castShadow = false;
    p.mesh.frustumCulled = true;
    p.mesh.computeBoundingSphere();
    g.add(p.mesh);
  }
  return g;
}

function jitter(geo: THREE.BufferGeometry, amt: number, seed: number) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const rng = new Rng(seed);
  const seen = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let k = seen.get(key);
    if (k === undefined) {
      k = 1 + (rng.next() - 0.5) * 2 * amt;
      seen.set(key, k);
    }
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * (1 + (k - 1) * 0.5), pos.getZ(i) * k);
  }
  geo.computeVertexNormals();
}

// ====================================================================== cars

/** A racer: Orangie on his turbo wheelchair, or the code-built kart if the model didn't load. */
function racer(color: string, skin = DEFAULT_SKIN): CarModel {
  if (!skinLoaded(skin)) skin = DEFAULT_SKIN;
  if (!skinLoaded(skin)) return orangeKart(color);
  const k = buildRacer(skin, color);
  const lod = new THREE.LOD();
  lod.addLevel(k.model, 0);
  lod.addLevel(k.far, 55);
  const body = new THREE.Group();
  body.add(lod);
  const root = new THREE.Group();
  root.add(body);
  return { root, body, wheels: [], front: [], tail: null, label: null, prevH: 0, prevSpeed: 0, spin: 0, pitch: 0, roll: 0, skid: [null, null], wheelR: 1, animate: k.animate, height: k.height };
}

/** Fallback racer: the orange in a rocket office chair (kart.ts), turned to face +X, with a cheap far LOD. */
function orangeKart(color: string): CarModel {
  const k = buildKart(color);
  k.model.rotation.y = -Math.PI / 2; // built facing -Z; our cars face +X
  k.far.rotation.y = -Math.PI / 2;
  const lod = new THREE.LOD();
  lod.addLevel(k.model, 0);
  lod.addLevel(k.far, 55);
  const body = new THREE.Group();
  body.add(lod);
  const root = new THREE.Group();
  root.add(body);
  return { root, body, wheels: k.wheels, front: k.front, tail: k.tail, label: null, prevH: 0, prevSpeed: 0, spin: 0, pitch: 0, roll: 0, skid: [null, null], wheelR: 0.075 * 1.8, animate: (t, _dt, speed) => k.animate(t, speed), height: 2.6 };
}

// ====================================================================== particles

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  r: number;
  g: number;
  b: number;
  a: number;
  grav: number;
  drag: number;
}

class Particles {
  points: THREE.Points;
  private ps: Particle[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  constructor(
    private max: number,
    blending: THREE.Blending,
  ) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending,
      vertexShader: /* glsl */ `
        attribute vec4 aColor; attribute float aSize; varying vec4 vColor;
        void main() { vColor = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (420.0 / max(-mv.z, 0.5)); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
          gl_FragColor = vec4(vColor.rgb, vColor.a * smoothstep(0.5, 0.15, d)); }`,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
  }
  emit(p: Particle) {
    if (this.ps.length >= this.max) this.ps.shift();
    this.ps.push(p);
  }
  update(dt: number) {
    let n = 0;
    const keep: Particle[] = [];
    for (const p of this.ps) {
      p.life += dt;
      if (p.life >= p.max) continue;
      p.vy -= p.grav * dt;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.vz *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.05) {
        p.y = 0.05;
        p.vy = 0;
        p.vx *= 0.8;
        p.vz *= 0.8;
      }
      p.size += p.grow * dt;
      const fade = 1 - p.life / p.max;
      this.pos[n * 3] = p.x;
      this.pos[n * 3 + 1] = p.y;
      this.pos[n * 3 + 2] = p.z;
      this.col[n * 4] = p.r;
      this.col[n * 4 + 1] = p.g;
      this.col[n * 4 + 2] = p.b;
      this.col[n * 4 + 3] = p.a * fade;
      this.size[n] = p.size;
      keep.push(p);
      n++;
    }
    this.ps = keep;
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('aColor').needsUpdate = true;
    g.getAttribute('aSize').needsUpdate = true;
  }
}

const rnd = (a: number) => (Math.random() - 0.5) * 2 * a;
function smokeParticle(x: number, y: number, z: number, dark = false): Particle {
  const c = dark ? 0.18 : 0.75;
  return { x, y, z, vx: rnd(0.8), vy: 0.8 + Math.random(), vz: rnd(0.8), life: 0, max: 1.6 + Math.random(), size: 0.8, grow: 2.4, r: c, g: c, b: c, a: 0.32, grav: -0.2, drag: 1.2 };
}
function dirtParticle(x: number, y: number, z: number, s: number): Particle {
  return { x, y, z, vx: rnd(s), vy: 2 + Math.random() * s, vz: rnd(s), life: 0, max: 0.9 + Math.random() * 0.6, size: 0.25 + Math.random() * 0.3, grow: 0, r: 0.32, g: 0.25, b: 0.16, a: 0.9, grav: 9.8, drag: 0.6 };
}
function leafParticle(x: number, y: number, z: number): Particle {
  const g = 0.3 + Math.random() * 0.35;
  return { x: x + rnd(2), y, z: z + rnd(2), vx: rnd(4), vy: 1 + Math.random() * 3, vz: rnd(4), life: 0, max: 2.5 + Math.random() * 1.5, size: 0.18 + Math.random() * 0.12, grow: 0, r: 0.15, g, b: 0.08, a: 1, grav: 2.5, drag: 1.6 };
}
function sparkParticle(x: number, y: number, z: number): Particle {
  return { x, y, z, vx: rnd(9), vy: 2 + Math.random() * 6, vz: rnd(9), life: 0, max: 0.35 + Math.random() * 0.4, size: 0.12, grow: 0, r: 1, g: 0.7, b: 0.25, a: 1, grav: 12, drag: 0.5 };
}

// ====================================================================== skid marks

class SkidMarks {
  mesh: THREE.Mesh;
  private pos: Float32Array;
  private alpha: Float32Array;
  private next = 0;
  constructor(private max: number) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 4 * 3);
    this.alpha = new Float32Array(max * 4);
    const idx: number[] = [];
    for (let i = 0; i < max; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2);
    g.setIndex(idx);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      vertexShader: `attribute float aAlpha; varying float vA; void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(0.02,0.02,0.02, vA * 0.55); }`,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
  }
  add(ax: number, az: number, bx: number, bz: number, strength: number) {
    const dx = bx - ax,
      dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * 0.14,
      nz = (dx / len) * 0.14;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const y = 0.045;
    this.pos.set([ax - nx, y, az - nz, ax + nx, y, az + nz, bx - nx, y, bz - nz, bx + nx, y, bz + nz], i * 12);
    this.alpha.fill(strength, i * 4, i * 4 + 4);
    const g = this.mesh.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('aAlpha').needsUpdate = true;
  }
  clear() {
    this.alpha.fill(0);
    this.mesh.geometry.getAttribute('aAlpha').needsUpdate = true;
  }
}

// ====================================================================== canvas textures

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

function leafTexture(pine: boolean) {
  return canvasTex(256, 256, (c) => {
    c.fillStyle = pine ? '#0e2614' : '#163a1a';
    c.fillRect(0, 0, 256, 256);
    const rng = new Rng(pine ? 77 : 33);
    for (let i = 0; i < (pine ? 2600 : 1400); i++) {
      const x = rng.next() * 256,
        y = rng.next() * 256;
      const l = pine ? 14 + rng.next() * 18 : 18 + rng.next() * 30;
      c.fillStyle = `hsl(${pine ? 135 + rng.next() * 15 : 95 + rng.next() * 35}, ${35 + rng.next() * 30}%, ${l}%)`;
      c.beginPath();
      if (pine) c.ellipse(x, y, 1, 5, rng.next() * 3.14, 0, Math.PI * 2);
      else c.ellipse(x, y, 4 + rng.next() * 3, 2 + rng.next() * 2, rng.next() * 3.14, 0, Math.PI * 2);
      c.fill();
    }
  });
}

function stripeTexture(a: string, b: string) {
  return canvasTex(16, 64, (c) => {
    c.fillStyle = a;
    c.fillRect(0, 0, 16, 32);
    c.fillStyle = b;
    c.fillRect(0, 32, 16, 32);
  });
}

function gravelTexture() {
  return canvasTex(128, 128, (c) => {
    c.fillStyle = '#8a7a62';
    c.fillRect(0, 0, 128, 128);
    const rng = new Rng(5);
    for (let i = 0; i < 1600; i++) {
      const v = 90 + rng.next() * 90;
      c.fillStyle = `rgb(${v},${v * 0.9},${v * 0.75})`;
      c.fillRect(rng.next() * 128, rng.next() * 128, 2, 2);
    }
  });
}

function concreteTexture() {
  return canvasTex(128, 128, (c) => {
    c.fillStyle = '#5e6266';
    c.fillRect(0, 0, 128, 128);
    const rng = new Rng(9);
    for (let i = 0; i < 900; i++) {
      const v = 80 + rng.next() * 50;
      c.fillStyle = `rgba(${v},${v},${v},0.5)`;
      c.fillRect(rng.next() * 128, rng.next() * 128, 2, 2);
    }
  });
}

function chainlinkTexture() {
  const t = canvasTex(64, 64, (c) => {
    c.clearRect(0, 0, 64, 64);
    c.strokeStyle = 'rgba(205,212,220,1)';
    c.lineWidth = 1.6;
    c.beginPath();
    for (let k = -64; k <= 64; k += 16) {
      c.moveTo(k, 0);
      c.lineTo(k + 64, 64);
      c.moveTo(k + 64, 0);
      c.lineTo(k, 64);
    }
    c.stroke();
  });
  t.repeat.set(1, 21); // 3.2 m tall fence -> same diamond size vertically as along
  return t;
}

function adTexture() {
  const ads = [
    ['RACETRENCH', '#06080b', '#a463ff'],
    ['RACE · BET · EARN', '#9945ff', '#ffffff'],
    ['AI GRAND PRIX', '#101826', '#22d3ee'],
    ['NIGHT SERIES', '#3a0f4f', '#ff3dbb'],
  ];
  return canvasTex(1024, 128, (c) => {
    ads.forEach(([text, bg, fg], i) => {
      const x = i * 256;
      c.fillStyle = bg;
      c.fillRect(x, 0, 256, 128);
      c.fillStyle = fg;
      c.font = 'italic 800 42px "Exo 2", sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, x + 128, 66, 236);
      c.fillRect(x, 0, 256, 6);
    });
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

function bannerTexture() {
  return canvasTex(512, 64, (c) => {
    c.fillStyle = '#07090c';
    c.fillRect(0, 0, 512, 64);
    c.fillStyle = '#9945ff';
    c.fillRect(0, 0, 512, 4);
    c.fillRect(0, 60, 512, 4);
    c.font = 'italic 800 38px "Exo 2", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#ffffff';
    c.textAlign = 'right';
    c.fillText('RACE', 222, 34);
    c.fillStyle = '#a463ff';
    c.textAlign = 'left';
    c.fillText('TRENCH', 226, 34);
  }, false);
}

function screenTexture() {
  return canvasTex(256, 128, (c) => {
    const g = c.createLinearGradient(0, 0, 256, 128);
    g.addColorStop(0, '#0b2a5a');
    g.addColorStop(1, '#3a0f4f');
    c.fillStyle = g;
    c.fillRect(0, 0, 256, 128);
    c.strokeStyle = '#9945ff';
    c.lineWidth = 6;
    c.strokeRect(3, 3, 250, 122);
    c.font = 'italic 800 34px "Exo 2", sans-serif';
    c.textAlign = 'center';
    c.fillStyle = '#ffffff';
    c.fillText('LIVE', 128, 60);
    c.fillStyle = '#c39bff';
    c.font = '600 18px "Barlow", sans-serif';
    c.fillText('RACETRENCH', 128, 92);
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

/** Free a group's geometry and its own materials; the shared session materials are kept. */
function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      if (sharedMats.has(mat)) continue;
      const map = (mat as THREE.MeshStandardMaterial).map;
      if (map && (map as THREE.CanvasTexture).isCanvasTexture) map.dispose();
      mat.dispose();
    }
  });
}

export type GfxMode = 'auto' | 'high' | 'low';
function readGfx(): GfxMode {
  try {
    const v = localStorage.getItem('tl-gfx');
    if (v === 'high' || v === 'low') return v;
  } catch {
    /* ignore */
  }
  return 'auto';
}
