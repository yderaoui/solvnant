// Realistic 3D race view (chase camera). Same race as the 2D map: sim (x, y) -> three (x, 0, y),
// heading h -> rotation.y = -h. Loaded on demand so 2D pages never download three.js or the assets.
//
// Assets (public/assets, credited in README):
//   - Ferrari 458 Italia model by vicent091036 (from the three.js examples)
//   - Poly Haven CC0: asphalt_02, aerial_grass_rock, pine_bark textures; rogland_clear_night HDRI
// Everything else (trees, crowd, stands, fences, kerbs, ad boards) is generated here.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
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

const ASSET = (p: string) => `${import.meta.env.BASE_URL}assets/${p}`;
const WALL = PHYS.runoff; // physical wall: this far beyond the track edge
const MAX_IMPACTS = 4;
const MAX_CARS_UNIFORM = 10;

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
  private carEntries: { name: string; color: string }[] = [];
  private you = -1;
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
  private carProto: THREE.Object3D | null = null;
  private aoTex: THREE.Texture;
  private T: Mats;
  // trees
  private treeParts: TreePart[][] = [];
  private treeAnim = new Map<number, TreeAnim>();
  // crowd
  private standPeople: Person[] = [];
  private zonePeople: Person[] = [];
  private crowdMesh: THREE.Mesh | null = null;
  private crowdMat: THREE.ShaderMaterial;
  private impacts: THREE.Vector4[] = [];
  private impactSlot = 0;
  private excite = 0;
  // fx
  private fx: Particles;
  private sparks: Particles;
  private skids: SkidMarks;
  // adaptive quality: 2 = full, 1 = lower resolution + smaller shadows, 0 = no bloom / no shadows
  private quality = 2;
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
    this.canvas = this.gl.domElement;
    this.canvas.className = 'chase3d';
    this.canvas.style.display = 'none';
    host.appendChild(this.canvas);

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
    this.aoTex = new THREE.TextureLoader().load(ASSET('models/ferrari_ao.png'));
    new HDRLoader().load(ASSET('tex/night_1k.hdr'), (t) => {
      t.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.environment = t;
      this.scene.environmentIntensity = 0.9;
      this.scene.background = t;
      this.scene.backgroundIntensity = 0.55;
    });
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    const gltf = new GLTFLoader();
    gltf.setDRACOLoader(draco);
    gltf.load(ASSET('models/ferrari.glb'), (g) => {
      this.carProto = g.scene.children[0];
      if (this.carEntries.length) this.setCars(this.carEntries, this.you);
    });

    this.crowdMat = crowdMaterial();
    for (let i = 0; i < MAX_IMPACTS; i++) this.impacts.push(new THREE.Vector4(0, 0, -99, 0));
    this.crowdMat.uniforms.uImpacts.value = this.impacts;

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

  /**
   * Watch real frame times; step quality down if the machine can't keep ~45 fps. Only things that
   * don't recompile shaders are changed (toggling lights or shadow casting would freeze the game
   * for seconds while every material recompiles): resolution, shadow map size/refresh, bloom.
   */
  private adaptQuality() {
    const now = performance.now();
    const ft = this.lastFrame ? now - this.lastFrame : 16;
    this.lastFrame = now;
    if (ft > 250 || !this.carProto || this.time < 4) return; // still loading / tab was hidden
    this.frameAcc += ft;
    this.frameN++;
    if (this.frameAcc < 3000) return;
    const avg = this.frameAcc / this.frameN;
    this.frameAcc = this.frameN = 0;
    if (avg < 22 || this.quality === 0) return;
    this.quality--;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (this.quality === 1) {
      this.gl.setPixelRatio(Math.max(0.75, dpr * 0.75));
      this.moon.shadow.mapSize.set(1024, 1024);
      this.moon.shadow.map?.dispose();
      this.moon.shadow.map = null;
    } else {
      this.bloom.enabled = false;
      this.gl.setPixelRatio(Math.max(0.6, dpr * 0.6));
      this.gl.shadowMap.autoUpdate = false; // refresh shadows every few frames instead
    }
    this.resize();
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
  setTrack(track: Track) {
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
    for (const st of straights.slice(0, 4)) {
      const m = (st.a + Math.floor(st.n / 2)) % N;
      const len = Math.min(st.n * sp * 0.7, 140);
      const nx = -Math.sin(H[m]),
        nz = Math.cos(H[m]);
      const side = (P[m][0] - cx) * nx + (P[m][1] - cz) * nz > 0 ? 1 : -1;
      const dist = W[m] / 2 + WALL + 6;
      // rotation -h puts local +z on the right of the track: a stand on the right must turn round to face it
      this.world.add(grandstand(len, T, rng, this.standPeople, P[m][0] + nx * side * dist, P[m][1] + nz * side * dist, -H[m] + (side > 0 ? 0 : Math.PI)));
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
    this.rebuildCrowd();
  }

  /** Solid obstacles of a live race: trees that can be hit, crowd fences with spectators behind. */
  setObstacles(ob: Obstacles | null) {
    disposeTree(this.obsGroup);
    this.obsGroup.clear();
    this.treeParts = [];
    this.treeAnim.clear();
    this.zonePeople = [];
    this.ob = ob;
    if (!ob) {
      this.rebuildCrowd();
      return;
    }
    const T = this.T;
    // Trees you can hit
    const parts = treeParts(T, ob.trees.length);
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
      this.obsGroup.add(p.mesh);
    }
    // Catch fences: ad-board base, chain-link above, posts; concrete terrace with fans behind
    const rng = Rng.fromString(`crowd:${this.track?.seed ?? ''}`);
    for (const z of ob.crowdZones) {
      const pts = z.pts;
      const ads = new THREE.Mesh(vstrip(pts, 0, 1.0, 9), T.adboard);
      ads.castShadow = true;
      ads.receiveShadow = true;
      const link = new THREE.Mesh(vstrip(pts, 1.0, 4.2, 2), T.chainlink);
      const back = pts.map((p, i) => [p[0] + z.nx[i] * 12, p[1] + z.ny[i] * 12] as Pt);
      const terrace = new THREE.Mesh(ribbon(pts, back, 0.04), T.concrete);
      terrace.receiveShadow = true;
      const along = polyline(pts, 4);
      const postMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, 4.3, 6), T.steel, Math.max(1, along.length));
      along.forEach(([x, y], i) => postMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 2.15, y)));
      this.obsGroup.add(ads, link, terrace, postMesh);
      const spots = polyline(pts, 0.8);
      spots.forEach(([x, y], i) => {
        const k = Math.min(z.nx.length - 1, Math.floor((i / spots.length) * z.nx.length));
        const nx = z.nx[k],
          ny = z.ny[k];
        for (let row = 0; row < 4; row++) {
          if (rng.next() < 0.18 + row * 0.08) continue;
          const d = 1.3 + row * 1.0 + rng.next() * 0.4;
          const j = (rng.next() - 0.5) * 0.5;
          this.zonePeople.push({ x: x + nx * d - ny * j, y: 0.04, z: y + ny * d + nx * j, dx: nx, dz: ny, v: Math.floor(rng.next() * 16), ph: rng.next() });
        }
      });
    }
    this.rebuildCrowd();
  }

  private rebuildCrowd() {
    if (this.crowdMesh) {
      this.scene.remove(this.crowdMesh);
      this.crowdMesh.geometry.dispose();
      this.crowdMesh = null;
    }
    const people = [...this.standPeople, ...this.zonePeople];
    if (!people.length) return;
    const base = new THREE.PlaneGeometry(0.62, 1.78).translate(0, 0.89, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('uv', base.getAttribute('uv'));
    const off = new Float32Array(people.length * 3),
      dir = new Float32Array(people.length * 2),
      vr = new Float32Array(people.length),
      ph = new Float32Array(people.length);
    people.forEach((p, i) => {
      off.set([p.x, p.y, p.z], i * 3);
      dir.set([p.dx, p.dz], i * 2);
      vr[i] = p.v;
      ph[i] = p.ph;
    });
    g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    g.setAttribute('aDir', new THREE.InstancedBufferAttribute(dir, 2));
    g.setAttribute('aVar', new THREE.InstancedBufferAttribute(vr, 1));
    g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(ph, 1));
    g.instanceCount = people.length;
    const mesh = new THREE.Mesh(g, this.crowdMat);
    mesh.frustumCulled = false;
    this.crowdMesh = mesh;
    this.scene.add(mesh);
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
  setCars(entries: { name: string; color: string }[], you: number) {
    this.carEntries = entries;
    this.you = you;
    for (const c of this.cars) {
      c.label?.material.map?.dispose();
      c.label?.material.dispose();
      this.carGroup.remove(c.root);
    }
    this.cars = entries.map((e, i) => {
      const m = this.carProto ? ferrari(this.carProto, e.color, this.aoTex) : boxCar(e.color);
      if (i !== you) {
        m.label = labelSprite(e.name, e.color);
        m.label.position.set(0, 2.6, 0);
        m.root.add(m.label);
      }
      this.carGroup.add(m.root);
      return m;
    });
    this.snap = true;
  }

  // ==================================================================== race events -> reactions
  onEvent(ev: RaceEvent, cars: CarVisual[]) {
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
      this.impacts[this.impactSlot].set(c.x, c.y, this.time, 1);
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
    if (!this.visible) return;
    this.time += dt;
    this.adaptQuality();
    this.focusIdx = focus;
    this.excite = Math.max(0, this.excite - dt * 0.18);
    const cam = this.camera.position;

    cars.forEach((c, i) => {
      const m = this.cars[i];
      if (!m || !c) return;
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
      m.spin += (c.speed * dt) / 0.34;
      const steer = THREE.MathUtils.clamp(yawRate * 0.35, -0.45, 0.45);
      for (const w of m.wheels) w.rotation.x = m.spin;
      for (const w of m.front) w.rotation.y = steer;
      if (m.tail) m.tail.emissiveIntensity = c.flags & FLAG.braking ? 4 : 0.8;
      const d = Math.hypot(c.x - cam.x, c.y - cam.z);
      if (m.label) m.label.visible = i !== focus && d > 14 && d < 260;
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

    // Chase camera (+ shake on impacts)
    const f = cars[focus];
    if (f) {
      const dx = Math.cos(f.h),
        dz = Math.sin(f.h);
      const back = 8.8 + Math.min(3, f.speed * 0.04);
      const want = new THREE.Vector3(f.x - dx * back, 2.9 + Math.min(0.8, f.speed * 0.01), f.y - dz * back);
      const look = new THREE.Vector3(f.x + dx * 8, 1.0, f.y + dz * 8);
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
    }

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
    const u = this.crowdMat.uniforms;
    u.uTime.value = this.time;
    u.uExcite.value = this.excite;
    const cu = u.uCars.value as THREE.Vector3[];
    for (let i = 0; i < MAX_CARS_UNIFORM; i++) {
      const c = cars[i];
      if (c) cu[i].set(c.x, c.y, Math.min(1, c.speed / 30));
      else cu[i].set(1e6, 1e6, 0);
    }

    this.fx.update(dt);
    this.sparks.update(dt);
    if (!this.gl.shadowMap.autoUpdate && Math.floor(this.time * 60) % 4 === 0) this.gl.shadowMap.needsUpdate = true;
    this.composer.render(dt);
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
    adboard: new THREE.MeshStandardMaterial({ map: adTex, emissive: 0xffffff, emissiveMap: adTex, emissiveIntensity: 0.35, roughness: 0.6, side: THREE.DoubleSide }),
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
    const seats = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.45), T.seat);
    seats.position.set(0, rowH * (r + 1) + 0.06, -depth / 2 + rowD * r + 0.35);
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
      v.set(s + (rng.next() - 0.5) * 0.15, rowH * (r + 1) - 0.45, -depth / 2 + rowD * r + 0.4).applyMatrix4(g.matrixWorld);
      people.push({ x: v.x, y: v.y, z: v.z, dx: away.x, dz: away.z, v: Math.floor(rng.next() * 16), ph: rng.next() });
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

/** Cabin/brake detail that can't be seen from a chase camera (~100k of the model's 360k triangles). */
const HIDDEN_PARTS = ['interior_light', 'steering_wheel', 'brakes', 'brake', 'carpet', 'nuts'];

/** Lightweight stand-in used beyond ~45 m: extruded side profile + cabin + wheels (~700 triangles). */
function proxyCar(paint: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const s = new THREE.Shape();
  // side profile, x along the car (+x = front), y up
  s.moveTo(-2.3, 0.3);
  s.lineTo(-2.3, 0.85);
  s.quadraticCurveTo(-1.6, 1.0, -0.9, 1.0);
  s.lineTo(1.2, 0.85);
  s.quadraticCurveTo(2.2, 0.7, 2.35, 0.45);
  s.lineTo(2.35, 0.3);
  s.lineTo(-2.3, 0.3);
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 1.9, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08, bevelSegments: 2, curveSegments: 4 }).translate(0, 0, -0.95), paint);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.38, 1.4).translate(-0.4, 1.17, 0), new THREE.MeshStandardMaterial({ color: 0x0b0f16, metalness: 0.3, roughness: 0.15 }));
  body.castShadow = cabin.castShadow = true;
  g.add(body, cabin);
  const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 12).rotateX(Math.PI / 2);
  const tyre = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
  for (const x of [1.45, -1.35]) for (const z of [0.9, -0.9]) {
    const w = new THREE.Mesh(wheel, tyre);
    w.position.set(x, 0.34, z);
    g.add(w);
  }
  return g;
}

function ferrari(proto: THREE.Object3D, color: string, ao: THREE.Texture): CarModel {
  const model = proto.clone(true);
  for (const name of HIDDEN_PARTS) {
    const kill: THREE.Object3D[] = [];
    model.traverse((o) => {
      if (o.name === name || o.name.startsWith(name + '_')) kill.push(o);
    });
    for (const o of kill) o.removeFromParent();
  }
  const paint = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), metalness: 0.75, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.03 });
  const details = new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 1, roughness: 0.25 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0b0f16, metalness: 0.2, roughness: 0, opacity: 0.85, transparent: true });
  const set = (name: string, mat: THREE.Material) => {
    const o = model.getObjectByName(name) as THREE.Mesh | undefined;
    if (o) o.material = mat;
  };
  set('body', paint);
  for (const r of ['rim_fl', 'rim_fr', 'rim_rr', 'rim_rl', 'trim']) set(r, details);
  set('glass', glass);
  let tail: THREE.MeshStandardMaterial | null = null;
  const lr = model.getObjectByName('lights_red') as THREE.Mesh | undefined;
  if (lr) {
    tail = new THREE.MeshStandardMaterial({ color: 0x400008, emissive: 0xff1a2e, emissiveIntensity: 0.8 });
    lr.material = tail;
  }
  const lights = model.getObjectByName('lights') as THREE.Mesh | undefined;
  if (lights) lights.material = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f8ff, emissiveIntensity: 2 });
  // Only the big parts cast shadows (the model has ~50 meshes; shadows for all of them double the draw calls).
  model.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.name === 'body' || o.name === 'tire';
  });
  const wheels = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].map((n) => model.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o);
  for (const w of wheels) w.rotation.order = 'YXZ';
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.655 * 4, 1.3 * 4).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: ao, blending: THREE.MultiplyBlending, toneMapped: false, transparent: true, premultipliedAlpha: true }),
  );
  shadow.renderOrder = 2;
  shadow.position.y = 0.01;
  model.add(shadow);
  // the model faces -Z; our cars face +X
  model.rotation.y = -Math.PI / 2;
  const near = new THREE.Group();
  near.add(model);
  const lod = new THREE.LOD();
  lod.addLevel(near, 0);
  lod.addLevel(proxyCar(paint), 45);
  const body = new THREE.Group();
  body.add(lod);
  const root = new THREE.Group();
  root.add(body);
  return { root, body, wheels, front: wheels.slice(0, 2), tail, label: null, prevH: 0, prevSpeed: 0, spin: 0, pitch: 0, roll: 0, skid: [null, null] };
}

/** Placeholder until the car model has loaded. */
function boxCar(color: string): CarModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.9, 1.9), new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.4 }));
  m.position.y = 0.55;
  m.castShadow = true;
  body.add(m);
  root.add(body);
  return { root, body, wheels: [], front: [], tail: null, label: null, prevH: 0, prevSpeed: 0, spin: 0, pitch: 0, roll: 0, skid: [null, null] };
}

// ====================================================================== crowd shader

function crowdMaterial(): THREE.ShaderMaterial {
  const cars: THREE.Vector3[] = [];
  for (let i = 0; i < MAX_CARS_UNIFORM; i++) cars.push(new THREE.Vector3(1e6, 1e6, 0));
  const mat = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uExcite: { value: 0 }, uLight: { value: 0.75 } }]),
    vertexShader: /* glsl */ `
      attribute vec3 aOffset;
      attribute vec2 aDir;
      attribute float aVar;
      attribute float aPhase;
      uniform float uTime;
      uniform float uExcite;
      uniform vec4 uImpacts[${MAX_IMPACTS}];
      uniform vec3 uCars[${MAX_CARS_UNIFORM}];
      varying vec2 vUv;
      varying float vShade;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vec3 base = aOffset;
        float excite = uExcite * (0.6 + 0.4 * fract(aPhase * 13.7));
        // cars going past get a cheer
        for (int i = 0; i < ${MAX_CARS_UNIFORM}; i++) {
          float d = distance(base.xz, uCars[i].xy);
          excite = max(excite, smoothstep(28.0, 6.0, d) * uCars[i].z * 0.8);
        }
        // a car slamming into the fence: fans close by jump back and throw their arms up
        float flee = 0.0;
        for (int i = 0; i < ${MAX_IMPACTS}; i++) {
          vec4 im = uImpacts[i];
          float age = uTime - im.z;
          if (age > 0.0 && age < 5.0) {
            float k = smoothstep(18.0, 3.0, distance(base.xz, im.xy)) * im.w;
            excite = max(excite, k);
            flee = max(flee, k * min(age * 2.0, 1.0) * (1.0 - smoothstep(3.0, 5.0, age)));
          }
        }
        base.xz += aDir * flee * 3.5;
        base.y += max(0.0, sin(uTime * (7.0 + aPhase * 4.0) + aPhase * 40.0)) * 0.22 * excite;
        vec2 toCam = normalize(cameraPosition.xz - base.xz);
        vec3 right = vec3(toCam.y, 0.0, -toCam.x); // camera's right, so the card faces the viewer
        vec3 p = base + right * position.x + vec3(0.0, position.y, 0.0);
        float arms = step(0.4, excite) * step(-0.3, sin(uTime * 2.5 + aPhase * 17.0));
        vUv = vec2((mod(aVar, 16.0) + uv.x) / 16.0, (uv.y + arms) / 2.0);
        vShade = 0.7 + 0.3 * fract(aPhase * 7.31);
        vec4 mvPosition = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform float uLight;
      varying vec2 vUv;
      varying float vShade;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec4 c = texture2D(uAtlas, vUv);
        if (c.a < 0.5) discard;
        gl_FragColor = vec4(c.rgb * uLight * vShade, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  // Array / texture uniforms are set after merge (merge clones values).
  mat.uniforms.uAtlas = { value: crowdAtlas() };
  mat.uniforms.uImpacts = { value: [] };
  mat.uniforms.uCars = { value: cars };
  return mat;
}

/** 16 spectator looks x 2 poses (top half of the canvas: arms up), drawn on a canvas. */
function crowdAtlas(): THREE.CanvasTexture {
  const W = 64,
    Hh = 128;
  const skins = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#5c3a21'];
  const shirts = ['#e3122d', '#1f6feb', '#f5f5f5', '#111418', '#8cff2e', '#ffd60a', '#ff8a1f', '#a259ff', '#22d3ee', '#ff3dbb', '#2e7d32', '#6b7280'];
  const pants = ['#1f2937', '#374151', '#1e3a8a', '#3f2a1d', '#111827'];
  const hairs = ['#1b1b1b', '#3b2416', '#7a4a1e', '#d9b26a', '#6b6b6b'];
  const rng = new Rng(4242);
  const pick = <T,>(a: T[]) => a[Math.floor(rng.next() * a.length)];
  return canvasTex(W * 16, Hh * 2, (c) => {
    for (let v = 0; v < 16; v++) {
      const skin = pick(skins),
        shirt = pick(shirts),
        pant = pick(pants),
        hair = pick(hairs);
      const cap = rng.next() < 0.3 ? pick(shirts) : null;
      const flag = v % 5 === 0 ? pick(shirts) : null;
      for (let pose = 0; pose < 2; pose++) {
        const up = pose === 1;
        c.save();
        c.translate(v * W, up ? 0 : Hh);
        // legs + shoes
        c.fillStyle = pant;
        c.fillRect(22, 80, 9, 44);
        c.fillRect(33, 80, 9, 44);
        c.fillStyle = '#0b0b0b';
        c.fillRect(21, 120, 11, 6);
        c.fillRect(32, 120, 11, 6);
        // torso
        const g = c.createLinearGradient(18, 0, 46, 0);
        g.addColorStop(0, shirt);
        g.addColorStop(1, shade(shirt, -0.35));
        c.fillStyle = g;
        c.beginPath();
        c.roundRect(18, 40, 28, 44, 6);
        c.fill();
        // arms (+ hands, + a flag for some)
        c.fillStyle = shade(shirt, -0.15);
        if (up) {
          c.fillRect(11, 10, 7, 36);
          c.fillRect(46, 10, 7, 36);
          c.fillStyle = skin;
          c.fillRect(11, 5, 7, 7);
          c.fillRect(46, 5, 7, 7);
          if (flag) {
            c.fillStyle = '#ddd';
            c.fillRect(52, 0, 2, 30);
            c.fillStyle = flag;
            c.fillRect(54, 0, 10, 12);
          }
        } else {
          c.fillRect(11, 42, 7, 34);
          c.fillRect(46, 42, 7, 34);
          c.fillStyle = skin;
          c.fillRect(11, 74, 7, 7);
          c.fillRect(46, 74, 7, 7);
        }
        // head + hair or cap
        c.fillStyle = skin;
        c.beginPath();
        c.arc(32, 28, 11, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = cap ?? hair;
        c.beginPath();
        c.arc(32, 25, 11.5, Math.PI, Math.PI * 2);
        c.fill();
        if (cap) c.fillRect(32, 22, 15, 4);
        c.restore();
      }
    }
  }, false);
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + (k < 0 ? v * k : (255 - v) * k))));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
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
    c.lineWidth = 2.2;
    c.beginPath();
    for (let k = -64; k <= 64; k += 16) {
      c.moveTo(k, 0);
      c.lineTo(k + 64, 64);
      c.moveTo(k + 64, 0);
      c.lineTo(k, 64);
    }
    c.stroke();
  });
  t.repeat.set(1, 6);
  return t;
}

function adTexture() {
  const ads = [
    ['TRACKLAB 2D', '#06080b', '#8cff2e'],
    ['RACE · BET · EARN', '#8cff2e', '#06080b'],
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
