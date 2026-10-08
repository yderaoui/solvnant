// The racer: Orangie on his turbo wheelchair (a Tripo model, optimised with gltf-transform: meshopt +
// webp). One shared mesh for every car; each racer gets a glowing ring in its player colour under the
// chair and exhaust flames out of the engine. The model is built facing -X with the engine at +X.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const ASSET = (p: string) => `${import.meta.env.BASE_URL}assets/${p}`;
export const ORANGIE_SCALE = 3.1; // model is ~1 unit long; the cars are ~3 m

let near: THREE.Object3D | null = null;
let far: THREE.Object3D | null = null;
let loading: Promise<boolean> | null = null;

function prep(o: THREE.Object3D) {
  o.traverse((m) => {
    if ((m as THREE.Mesh).isMesh) {
      m.castShadow = true;
      m.receiveShadow = false;
    }
  });
  return o;
}

/** Loads the models once. Resolves false if they can't be loaded (the caller falls back). */
export function loadOrangie(): Promise<boolean> {
  loading ??= (async () => {
    try {
      const l = new GLTFLoader();
      l.setMeshoptDecoder(MeshoptDecoder);
      const [a, b] = await Promise.all([l.loadAsync(ASSET('characters/orangie.glb')), l.loadAsync(ASSET('characters/orangie-far.glb'))]);
      near = prep(a.scene);
      far = prep(b.scene);
      return true;
    } catch (e) {
      console.warn('orangie model failed to load', e);
      return false;
    }
  })();
  return loading;
}

export const orangieLoaded = () => near !== null;

const G = {
  ring: new THREE.RingGeometry(0.7, 0.8, 40).rotateX(-Math.PI / 2),
  glow: new THREE.CircleGeometry(0.8, 40).rotateX(-Math.PI / 2),
  flame: new THREE.ConeGeometry(1, 1, 12, 1, true).translate(0, -0.5, 0).rotateZ(Math.PI / 2), // tip towards +X
};
const flameMat = new THREE.MeshBasicMaterial({ color: 0xff8a1a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

export interface OrangieParts {
  model: THREE.Object3D; // faces +X, sits on y = 0, car-sized
  far: THREE.Object3D;
  animate: (t: number, speed: number) => void;
}

/** One racer. Call only after loadOrangie() resolved true. */
export function buildOrangie(color: string): OrangieParts {
  const model = new THREE.Group();
  const rider = new THREE.Group();
  rider.scale.setScalar(ORANGIE_SCALE);
  rider.rotation.y = Math.PI; // engine to the back: face +X
  rider.add(near!.clone());
  model.add(rider);

  // player colour: a bright ring + soft disc on the ground
  const c = new THREE.Color(color);
  const ring = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: c, toneMapped: false, transparent: true, opacity: 0.85, depthWrite: false }));
  const glow = new THREE.Mesh(G.glow, new THREE.MeshBasicMaterial({ color: c, toneMapped: false, transparent: true, opacity: 0.12, depthWrite: false }));
  for (const m of [ring, glow]) {
    m.scale.set(2.1, 1, 1.5);
    m.position.y = 0.04;
    m.renderOrder = 1;
    model.add(m);
  }

  // exhaust flames out of the engine (behind the chair, in the model's -X after the turn)
  const flames: THREE.Mesh[] = [];
  const cores: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const f = new THREE.Mesh(G.flame, flameMat);
    const k = new THREE.Mesh(G.flame, coreMat);
    for (const m of [f, k]) {
      m.rotation.y = Math.PI; // point backwards
      m.position.set(-0.5 * ORANGIE_SCALE, 0.24 * ORANGIE_SCALE, s * 0.1 * ORANGIE_SCALE);
      model.add(m);
    }
    flames.push(f);
    cores.push(k);
  }

  const farModel = new THREE.Group();
  const fr = new THREE.Group();
  fr.scale.setScalar(ORANGIE_SCALE);
  fr.rotation.y = Math.PI;
  fr.add(far!.clone());
  farModel.add(fr, ring.clone());

  let bob = 0;
  const animate = (t: number, speed: number) => {
    const k = Math.min(1, speed / 30);
    const on = speed > 0.5;
    for (let i = 0; i < flames.length; i++) {
      const f = 0.5 + k * 1.2 + Math.sin(t * 47 + i * 2) * 0.1 + Math.sin(t * 31 + i) * 0.07;
      flames[i].scale.set(0.2 + f * 0.45, 0.13 + k * 0.03, 0.13 + k * 0.03);
      cores[i].scale.set(0.12 + f * 0.22, 0.06, 0.06);
      flames[i].visible = cores[i].visible = on;
    }
    // the chair rumbles: a small bounce that grows with speed, and a little wobble
    bob += 0.016 * (8 + k * 14);
    rider.position.y = Math.abs(Math.sin(bob)) * (0.01 + k * 0.05);
    rider.rotation.x = Math.sin(bob * 0.5) * 0.02 * k;
  };
  return { model, far: farModel, animate };
}
