// 3D racers from the skin catalog (src/game/skins.ts). Each skin is a Tripo model optimised with
// gltf-transform (meshopt + webp), with a near and a far version. A skin is downloaded the first time a
// race needs it; every racer using it shares its meshes. Each racer gets a glowing ring in its player
// colour on the ground and exhaust flames.
//
// The models are single statues (no skeleton), so the near model is animated in the vertex shader:
// the rider's head turns about the neck, the upper body sways about the hips, the wheels spin about
// their axles, and some skins have an extra part that bobbles (Kimchi's giant head, Ansem's bull).
// Where those parts are comes from the skin's rig (measured by hand).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { skinById } from '../game/skins';

const ASSET = (p: string) => `${import.meta.env.BASE_URL}assets/${p}`;

interface Part {
  geometry: THREE.BufferGeometry; // baked: facing +X, model units (the yaw and node transforms applied)
  material: THREE.Material;
}

interface Proto {
  near: Part[];
  far: Part[];
  scale: number;
  offset: THREE.Vector3; // puts the scaled model centred on the origin, wheels on y = 0
  size: THREE.Vector3; // scaled, m
  rig: Record<string, THREE.IUniform>; // the skin's static rig uniforms, shared by its racers
}

const protos = new Map<string, Proto>();
const loads = new Map<string, Promise<boolean>>();

/** Every mesh of a glTF scene, with its transforms and the skin's yaw baked into float geometry. */
function bake(scene: THREE.Object3D, yaw: number): Part[] {
  const turn = new THREE.Group();
  turn.rotation.y = yaw;
  turn.add(scene);
  turn.updateMatrixWorld(true);
  const parts: Part[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    // quantized (normalized int) attributes would clamp when transformed: make them float first
    for (const name of ['position', 'normal'] as const) {
      const a = g.getAttribute(name);
      if (!a) continue;
      const f = new Float32Array(a.count * 3);
      for (let i = 0; i < a.count; i++) {
        f[i * 3] = a.getX(i);
        f[i * 3 + 1] = a.getY(i);
        f[i * 3 + 2] = a.getZ(i);
      }
      g.setAttribute(name, new THREE.BufferAttribute(f, 3));
    }
    g.applyMatrix4(m.matrixWorld);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    parts.push({ geometry: g, material: m.material as THREE.Material });
  });
  return parts;
}

/** Downloads a skin once. Resolves false if it can't be loaded (the caller falls back). */
export function loadSkin(id: string): Promise<boolean> {
  const skin = skinById(id);
  let p = loads.get(skin.id);
  if (!p) {
    p = (async () => {
      try {
        const l = new GLTFLoader();
        l.setMeshoptDecoder(MeshoptDecoder);
        const [a, b] = await Promise.all([l.loadAsync(ASSET(`characters/${skin.file}.glb`)), l.loadAsync(ASSET(`characters/${skin.file}-far.glb`))]);
        const near = bake(a.scene, skin.yaw);
        const far = bake(b.scene, skin.yaw);
        const box = new THREE.Box3();
        for (const n of near) box.union(n.geometry.boundingBox!);
        const raw = box.getSize(new THREE.Vector3());
        const scale = skin.length / raw.x;
        const c = box.getCenter(new THREE.Vector3());
        const r = skin.rig;
        const wheels = Array.from({ length: 4 }, (_, i) => {
          const w = r.wheels[i];
          return w ? new THREE.Vector4(w[0], w[1], w[2], 1) : new THREE.Vector4(0, 0, 0, 0);
        });
        const e = r.extra;
        protos.set(skin.id, {
          near,
          far,
          scale,
          offset: new THREE.Vector3(-c.x * scale, -box.min.y * scale, -c.z * scale),
          size: raw.clone().multiplyScalar(scale),
          rig: {
            rHead: { value: new THREE.Vector4(...r.head) },
            rNeck: { value: r.neck },
            rBody: { value: new THREE.Vector4(...r.body) },
            rWheels: { value: wheels },
            rWheelZ: { value: Math.max(Math.abs(box.min.z), Math.abs(box.max.z)) * 0.55 }, // tyres are on the outside
            rExtra: { value: e ? new THREE.Vector4(e[0], e[1], e[2], e[3]) : new THREE.Vector4(0, 0, 0, 0) },
            rExtraPivot: { value: e ? new THREE.Vector2(e[4], e[5]) : new THREE.Vector2() },
          },
        });
        return true;
      } catch (e) {
        console.warn(`racer skin "${skin.id}" failed to load`, e);
        return false;
      }
    })();
    loads.set(skin.id, p);
  }
  return p;
}

export const skinLoaded = (id: string) => protos.has(skinById(id).id);

// ---------------------------------------------------------------------------------- shader rig
const RIG_GLSL = /* glsl */ `
uniform vec4 rHead; uniform float rNeck; uniform vec4 rBody;
uniform vec4 rWheels[4]; uniform float rWheelZ;
uniform vec4 rExtra; uniform vec2 rExtraPivot;
uniform vec3 aHead; uniform vec2 aBody; uniform float aSpin; uniform vec2 aExtra;
vec3 rgX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z); }
vec3 rgY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
vec3 rgZ(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z); }
void rig(inout vec3 p, inout vec3 n) {
  vec3 p0 = p;
  // wheels: spin about the axle (x, y), tyres only (|z| beyond the body)
  if (abs(p0.z) > rWheelZ) {
    for (int i = 0; i < 4; i++) {
      vec4 w = rWheels[i];
      if (w.w < 0.5) continue;
      float d = length(p0.xy - w.xy);
      float k = smoothstep(w.z * 1.03, w.z * 0.93, d);
      if (k > 0.0) {
        float a = -aSpin / w.z * k;
        p = vec3(w.xy + (rgZ(vec3(p0.xy - w.xy, 0.0), a)).xy, p.z);
        n = rgZ(n, a);
      }
    }
  }
  // a part that bobbles about its pivot (springy)
  if (rExtra.w > 0.0) {
    float k = smoothstep(rExtra.w * 1.15, rExtra.w * 0.8, length(p0 - rExtra.xyz));
    if (k > 0.0) {
      vec3 pv = vec3(rExtraPivot, rExtra.z);
      vec3 q = rgY(rgZ(p - pv, aExtra.x * k), aExtra.y * k);
      p = pv + q;
      n = rgY(rgZ(n, aExtra.x * k), aExtra.y * k);
    }
  }
  // head about the neck: look (y), nod (z), tilt (x)
  float kh = smoothstep(rHead.w * 1.5, rHead.w * 1.12, length(p0 - rHead.xyz)) * smoothstep(rNeck - 0.015, rNeck + 0.025, p0.y);
  if (kh > 0.0) {
    vec3 pv = vec3(rHead.x, rNeck, rHead.z);
    p = pv + rgX(rgZ(rgY(p - pv, aHead.x * kh), aHead.y * kh), aHead.z * kh);
    n = rgX(rgZ(rgY(n, aHead.x * kh), aHead.y * kh), aHead.z * kh);
  }
  // upper body about the hips: sway (x), lean back/forward (z); the head goes with it
  float e = length(vec2((p0.x - rBody.x) / rBody.z, p0.z / rBody.w));
  float kb = smoothstep(rBody.y - 0.02, rBody.y + 0.07, p0.y) * (1.0 - smoothstep(0.8, 1.15, e));
  float kn = 1.0 - smoothstep(0.8, 1.15, length(vec2((rHead.x - rBody.x) / rBody.z, rHead.z / rBody.w))); // at the neck
  kb = mix(kb, kn, kh); // the whole head rides on the body as one piece
  if (kb > 0.0) {
    vec3 pv = vec3(rBody.x, rBody.y, 0.0);
    p = pv + rgZ(rgX(p - pv, aBody.x * kb), aBody.y * kb);
    n = rgZ(rgX(n, aBody.x * kb), aBody.y * kb);
  }
}
`;

interface Pose {
  aHead: THREE.IUniform<THREE.Vector3>; // yaw, nod, tilt (rad)
  aBody: THREE.IUniform<THREE.Vector2>; // sway, lean (rad)
  aSpin: THREE.IUniform<number>; // distance rolled, model units
  aExtra: THREE.IUniform<THREE.Vector2>; // bobble nod, turn (rad)
}

function rigMaterial(src: THREE.Material, rig: Record<string, THREE.IUniform>, pose: Pose): THREE.Material {
  const m = src.clone();
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, rig, pose);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${RIG_GLSL}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3( normal );\nvec3 rigPos = vec3( position );\nrig( rigPos, objectNormal );')
      .replace('#include <begin_vertex>', 'vec3 transformed = rigPos;');
  };
  m.customProgramCacheKey = () => 'racer-rig-1'; // one program for every rigged racer
  return m;
}

// ---------------------------------------------------------------------------------- racers
const G = {
  ring: new THREE.RingGeometry(0.7, 0.8, 40).rotateX(-Math.PI / 2),
  glow: new THREE.CircleGeometry(0.8, 40).rotateX(-Math.PI / 2),
  flame: new THREE.ConeGeometry(1, 1, 12, 1, true).translate(0, -0.5, 0).rotateZ(Math.PI / 2), // tip towards +X
};
const flameMat = new THREE.MeshBasicMaterial({ color: 0xff8a1a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

export interface RacerParts {
  model: THREE.Object3D; // faces +X, sits on y = 0, car-sized
  far: THREE.Object3D;
  height: number; // m
  /** yawRate: rad/s (+ = turning towards +z); accel: m/s² along the car */
  animate: (t: number, dt: number, speed: number, yawRate: number, accel: number) => void;
  pose: Pose; // exposed for tests
}

function place(parts: Part[], p: Proto, material?: (m: THREE.Material) => THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.position.copy(p.offset);
  g.scale.setScalar(p.scale);
  for (const part of parts) {
    const mesh = new THREE.Mesh(part.geometry, material ? material(part.material) : part.material);
    mesh.castShadow = true;
    g.add(mesh);
  }
  return g;
}

/** A damped spring: smooth, slightly overshooting follow of a target (feels physical). */
class Spring {
  x = 0;
  v = 0;
  constructor(
    private k: number,
    private c: number,
  ) {}
  step(target: number, dt: number) {
    const h = Math.min(dt, 0.05);
    this.v += ((target - this.x) * this.k - this.v * this.c) * h;
    this.x += this.v * h;
    return this.x;
  }
}

const clamp = (v: number, a: number) => Math.max(-a, Math.min(a, v));

/** One racer. Call only after loadSkin(id) resolved true. */
export function buildRacer(id: string, color: string): RacerParts {
  const skin = skinById(id);
  const p = protos.get(skin.id)!;
  const pose: Pose = { aHead: { value: new THREE.Vector3() }, aBody: { value: new THREE.Vector2() }, aSpin: { value: 0 }, aExtra: { value: new THREE.Vector2() } };
  const model = new THREE.Group();
  const bounce = new THREE.Group();
  bounce.add(place(p.near, p, (m) => rigMaterial(m, p.rig, pose)));
  model.add(bounce);

  // player colour: a bright ring + soft disc on the ground, sized to the vehicle
  const c = new THREE.Color(color);
  const ring = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: c, toneMapped: false, transparent: true, opacity: 0.85, depthWrite: false }));
  const glow = new THREE.Mesh(G.glow, new THREE.MeshBasicMaterial({ color: c, toneMapped: false, transparent: true, opacity: 0.12, depthWrite: false }));
  for (const m of [ring, glow]) {
    m.scale.set(p.size.x * 0.68, 1, Math.max(1.5, p.size.z * 0.85));
    m.position.y = 0.04;
    m.renderOrder = 1;
    model.add(m);
  }

  // exhaust flames, pointing backwards
  const flames: THREE.Mesh[] = [];
  const cores: THREE.Mesh[] = [];
  const outer = skin.rainbow ? flameMat.clone() : flameMat; // rainbow skins get their own, recoloured each frame
  for (const [x, y, z] of skin.exhaust) {
    const f = new THREE.Mesh(G.flame, outer);
    const k = new THREE.Mesh(G.flame, coreMat);
    for (const m of [f, k]) {
      m.rotation.y = Math.PI;
      m.position.set(x * p.scale + p.offset.x, y * p.scale + p.offset.y, z * p.scale + p.offset.z);
      bounce.add(m);
    }
    flames.push(f);
    cores.push(k);
  }

  const far = new THREE.Group();
  far.add(place(p.far, p), ring.clone());

  // Motion: springs follow what the car does, plus a little life when it's slow
  const seed = Math.random() * 100;
  const look = new Spring(40, 9),
    nod = new Spring(70, 8),
    tilt = new Spring(50, 8),
    sway = new Spring(45, 6),
    lean = new Spring(55, 7),
    bob = new Spring(90, 4), // the bobblehead: loose and wobbly
    bobTurn = new Spring(70, 4),
    heave = new Spring(120, 11);
  let spin = 0;
  const animate = (t: number, dt: number, speed: number, yawRate: number, accel: number) => {
    const k = Math.min(1, speed / 30);
    const idle = 1 - Math.min(1, speed / 6); // stopped or crawling: look around, vibe
    const T = t + seed;
    const lat = clamp(yawRate * speed, 25); // sideways acceleration, m/s²
    const a = clamp(accel, 20);
    // head: looks into the corner, gets pushed back when accelerating, tilts with the turn; when idle
    // it looks around and bobs to the beat
    const vibe = Math.max(0, Math.sin(T * 7.5)) ** 2;
    pose.aHead.value.set(
      look.step((skin.rig.face ?? 0) + clamp(-yawRate * 0.5, 0.45) + idle * Math.sin(T * 0.6) * 0.32, dt),
      nod.step(clamp(a * 0.018, 0.22) + idle * vibe * -0.12 + k * Math.sin(T * 11) * 0.025, dt),
      tilt.step(clamp(lat * 0.012, 0.22) + Math.sin(T * 1.3) * 0.04, dt),
    );
    // body: thrown to the outside of the corner, back when accelerating, forward when braking
    pose.aBody.value.set(sway.step(clamp(-lat * 0.009, 0.16) + Math.sin(T * 1.1) * 0.015, dt), lean.step(clamp(a * 0.012, 0.13) + idle * vibe * -0.025, dt));
    // bobblehead: kicked by everything, wobbles back
    pose.aExtra.value.set(bob.step(clamp(a * 0.03, 0.3) + k * Math.sin(T * 9) * 0.05, dt), bobTurn.step(clamp(-yawRate * 0.5, 0.4), dt));
    // wheels roll with the distance travelled
    spin += (speed * dt) / p.scale;
    pose.aSpin.value = spin;
    // suspension: a soft heave from the road and from braking/accelerating
    bounce.position.y = heave.step(k * (Math.sin(T * 13) * 0.012 + Math.sin(T * 7.3) * 0.01) - clamp(a, 10) * 0.002, dt) + 0.004 * Math.sin(T * 40) * k;

    if (skin.rainbow) outer.color.setHSL((t * 0.6) % 1, 1, 0.55);
    const on = speed > 0.5;
    for (let i = 0; i < flames.length; i++) {
      const f = 0.5 + k * 1.2 + Math.sin(t * 47 + i * 2) * 0.1 + Math.sin(t * 31 + i) * 0.07;
      flames[i].scale.set(0.2 + f * 0.45, 0.13 + k * 0.03, 0.13 + k * 0.03);
      cores[i].scale.set(0.12 + f * 0.22, 0.06, 0.06);
      flames[i].visible = cores[i].visible = on;
    }
  };
  return { model, far, height: p.size.y, animate, pose };
}
