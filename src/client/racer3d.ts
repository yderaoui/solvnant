// 3D racers from the skin catalog (src/game/skins.ts). Each skin is a Tripo model optimised with
// gltf-transform (meshopt + webp), with a near and a far version. A skin is downloaded the first time a
// race needs it; every racer using it shares its meshes. Each racer gets a glowing ring in its player
// colour on the ground and exhaust flames.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { skinById, type Skin } from '../game/skins';

const ASSET = (p: string) => `${import.meta.env.BASE_URL}assets/${p}`;

interface Proto {
  near: THREE.Object3D;
  far: THREE.Object3D;
  scale: number;
  offset: THREE.Vector3; // puts the scaled model centred on the origin, wheels on y = 0
  size: THREE.Vector3; // scaled, m
}

const protos = new Map<string, Proto>();
const loads = new Map<string, Promise<boolean>>();

function prep(o: THREE.Object3D) {
  o.traverse((m) => {
    if ((m as THREE.Mesh).isMesh) {
      m.castShadow = true;
      m.receiveShadow = false;
    }
  });
  return o;
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
        // measure it facing +X, then scale to the skin's length
        const probe = new THREE.Group();
        probe.rotation.y = skin.yaw;
        probe.add(a.scene);
        probe.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(probe);
        probe.remove(a.scene);
        const raw = box.getSize(new THREE.Vector3());
        const scale = skin.length / raw.x;
        const c = box.getCenter(new THREE.Vector3());
        protos.set(skin.id, {
          near: prep(a.scene),
          far: prep(b.scene),
          scale,
          offset: new THREE.Vector3(-c.x * scale, -box.min.y * scale, -c.z * scale),
          size: raw.multiplyScalar(scale),
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
  animate: (t: number, speed: number) => void;
}

function place(src: THREE.Object3D, skin: Skin, p: Proto): THREE.Group {
  const g = new THREE.Group();
  g.position.copy(p.offset);
  g.scale.setScalar(p.scale);
  const turn = new THREE.Group();
  turn.rotation.y = skin.yaw;
  turn.add(src.clone());
  g.add(turn);
  return g;
}

/** One racer. Call only after loadSkin(id) resolved true. */
export function buildRacer(id: string, color: string): RacerParts {
  const skin = skinById(id);
  const p = protos.get(skin.id)!;
  const model = new THREE.Group();
  const bounce = new THREE.Group();
  bounce.add(place(p.near, skin, p));
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
  far.add(place(p.far, skin, p), ring.clone());

  let bob = 0;
  const animate = (t: number, speed: number) => {
    const k = Math.min(1, speed / 30);
    const on = speed > 0.5;
    if (skin.rainbow) outer.color.setHSL((t * 0.6) % 1, 1, 0.55);
    for (let i = 0; i < flames.length; i++) {
      const f = 0.5 + k * 1.2 + Math.sin(t * 47 + i * 2) * 0.1 + Math.sin(t * 31 + i) * 0.07;
      flames[i].scale.set(0.2 + f * 0.45, 0.13 + k * 0.03, 0.13 + k * 0.03);
      cores[i].scale.set(0.12 + f * 0.22, 0.06, 0.06);
      flames[i].visible = cores[i].visible = on;
    }
    // engine rumble: a small bounce that grows with speed, and a little wobble
    bob += 0.016 * (8 + k * 14);
    bounce.position.y = Math.abs(Math.sin(bob)) * (0.03 + k * 0.15);
    bounce.rotation.x = Math.sin(bob * 0.5) * 0.02 * k;
  };
  return { model, far, height: p.size.y, animate };
}
