// The racer: a chubby cartoon orange in a rocket-powered office chair. Built from simple shapes in
// code (no model file to download or licence): swivel seat + backrest + armrests in the player's
// colour, five-star base on spinning casters, a red rocket strapped to the back with a flickering
// flame, and the orange itself: big grin, googly eyes, sunglasses pushed up, backwards cap in the
// player's colour, gold chain with a coin. Faces -Z here; the caller turns it to face +X like the
// old car. Shared geometry/materials are made once; only the coloured parts are per player.
import * as THREE from 'three';

export interface KartParts {
  model: THREE.Group; // faces -Z, wheels' axles along X
  wheels: THREE.Object3D[];
  front: THREE.Object3D[];
  tail: THREE.MeshStandardMaterial;
  far: THREE.Group; // cheap stand-in for far away
  animate: (t: number, speed: number) => void;
}

const S = 1.8; // the whole thing is modelled at chair scale and scaled up to fill the car's footprint

let shared: ReturnType<typeof makeShared> | null = null;

function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeShared() {
  // orange peel: fine noise as a bump map
  const peel = canvasTexture(128, 128, (c) => {
    const img = c.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 120 + Math.random() * 110;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  });
  peel.colorSpace = THREE.NoColorSpace;
  peel.wrapS = peel.wrapT = THREE.RepeatWrapping;
  peel.repeat.set(4, 3);
  const coinFace = canvasTexture(128, 128, (c) => {
    const g = c.createRadialGradient(64, 54, 10, 64, 64, 64);
    g.addColorStop(0, '#fff3b0');
    g.addColorStop(1, '#d9a21a');
    c.fillStyle = g;
    c.beginPath();
    c.arc(64, 64, 62, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#a8740c';
    c.lineWidth = 6;
    c.stroke();
    c.fillStyle = '#a8740c';
    c.font = 'bold 76px Arial';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('$', 64, 68);
  });
  const number = canvasTexture(128, 96, (c) => {
    c.fillStyle = '#ffffff';
    c.font = 'italic 900 78px Arial';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 8;
    c.strokeStyle = '#111827';
    c.strokeText('69', 64, 52);
    c.fillText('69', 64, 52);
  });
  return {
    geo: {
      sphere: new THREE.SphereGeometry(1, 28, 20),
      lowSphere: new THREE.SphereGeometry(1, 10, 8),
      cyl: new THREE.CylinderGeometry(1, 1, 1, 16),
      box: new THREE.BoxGeometry(1, 1, 1),
      capsule: new THREE.CapsuleGeometry(1, 1, 4, 10),
      cone: new THREE.ConeGeometry(1, 1, 16),
      torus: new THREE.TorusGeometry(1, 0.08, 6, 40),
      wheel: new THREE.CylinderGeometry(0.075, 0.075, 0.07, 14).rotateZ(Math.PI / 2), // axle along X
      flame: new THREE.ConeGeometry(1, 1, 14, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2), // tip towards +Z
      plate: new THREE.PlaneGeometry(1, 0.75),
    },
    mat: {
      orange: new THREE.MeshStandardMaterial({ color: 0xff8a12, roughness: 0.55, bumpMap: peel, bumpScale: 0.6 }),
      leaf: new THREE.MeshStandardMaterial({ color: 0x3fa535, roughness: 0.7 }),
      white: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }),
      black: new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.3 }),
      mouth: new THREE.MeshStandardMaterial({ color: 0x5a0e0e, roughness: 0.6 }),
      shades: new THREE.MeshPhysicalMaterial({ color: 0x050608, metalness: 0.4, roughness: 0.08, clearcoat: 1 }),
      gold: new THREE.MeshStandardMaterial({ color: 0xf2b829, metalness: 1, roughness: 0.22, emissive: 0x3a2400 }),
      coin: new THREE.MeshStandardMaterial({ map: coinFace, emissiveMap: coinFace, emissive: 0xffffff, emissiveIntensity: 0.55, metalness: 0.3, roughness: 0.35 }),
      frame: new THREE.MeshStandardMaterial({ color: 0x1b2230, metalness: 0.6, roughness: 0.35 }),
      caster: new THREE.MeshStandardMaterial({ color: 0x0f1218, roughness: 0.6 }),
      rocket: new THREE.MeshStandardMaterial({ color: 0xd51f2a, metalness: 0.35, roughness: 0.35 }),
      steel: new THREE.MeshStandardMaterial({ color: 0xb8c0c8, metalness: 1, roughness: 0.3 }),
      flame: new THREE.MeshBasicMaterial({ color: 0xff8a1a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      core: new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      number: new THREE.MeshBasicMaterial({ map: number, transparent: true }),
    },
  };
}

function part(geo: THREE.BufferGeometry, mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, parent: THREE.Object3D, cast = false) {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.castShadow = cast;
  parent.add(m);
  return m;
}

export function buildKart(color: string): KartParts {
  shared ??= makeShared();
  const { geo: G, mat: M } = shared;
  const paint = new THREE.Color(color);
  const seatMat = new THREE.MeshStandardMaterial({ color: paint.clone().multiplyScalar(0.55), roughness: 0.6 });
  const capMat = new THREE.MeshStandardMaterial({ color: paint, roughness: 0.5 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x400008, emissive: 0xff1a2e, emissiveIntensity: 0.8 });

  const model = new THREE.Group();
  const kart = new THREE.Group();
  kart.scale.setScalar(S);
  model.add(kart);

  // --- office chair -----------------------------------------------------------------------
  const wheels: THREE.Object3D[] = [];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + Math.PI / 5; // two legs forward
    const leg = part(G.box, M.frame, 0.06, 0.04, 0.42, Math.sin(a) * 0.21, 0.11, Math.cos(a) * 0.21, kart);
    leg.rotation.y = a;
    const w = new THREE.Group();
    w.position.set(Math.sin(a) * 0.42, 0.075, Math.cos(a) * 0.42);
    w.rotation.order = 'YXZ';
    w.add(new THREE.Mesh(G.wheel, M.caster));
    kart.add(w);
    wheels.push(w);
  }
  const front = wheels.filter((w) => w.position.z < 0);
  part(G.cyl, M.steel, 0.035, 0.36, 0.035, 0, 0.32, 0, kart); // gas lift
  part(G.box, seatMat, 0.62, 0.13, 0.6, 0, 0.55, 0, kart, true); // seat cushion
  const back = part(G.box, seatMat, 0.6, 0.5, 0.12, 0, 0.84, 0.31, kart, true); // backrest (low: the orange shows from behind)
  back.rotation.x = -0.12;
  for (const s of [-1, 1]) {
    part(G.box, M.frame, 0.05, 0.22, 0.05, s * 0.32, 0.7, 0.05, kart); // armrest post
    part(G.box, seatMat, 0.09, 0.05, 0.4, s * 0.33, 0.82, -0.02, kart); // armrest pad
    const plate = new THREE.Mesh(G.plate, M.number); // "69" on both sides of the seat
    plate.scale.setScalar(0.3);
    plate.position.set(s * 0.315, 0.55, 0.02);
    plate.rotation.y = s * (Math.PI / 2);
    kart.add(plate);
  }
  const brake = part(G.box, tail, 0.32, 0.05, 0.02, 0, 0.66, 0.38, kart); // brake light strip under the backrest
  brake.rotation.x = -0.12;

  // --- rocket strapped to the back -----------------------------------------------------------
  const rocket = new THREE.Group();
  rocket.position.set(0, 1.05, 0.55);
  kart.add(rocket);
  part(G.cyl, M.rocket, 0.14, 0.62, 0.14, 0, 0, 0, rocket, true).rotation.x = Math.PI / 2;
  const nose = part(G.cone, M.rocket, 0.14, 0.26, 0.14, 0, 0, -0.44, rocket);
  nose.rotation.x = -Math.PI / 2;
  for (const z of [-0.15, 0.12]) part(G.cyl, M.steel, 0.15, 0.03, 0.15, 0, 0, z, rocket).rotation.x = Math.PI / 2; // straps
  part(G.cyl, M.steel, 0.1, 0.1, 0.1, 0, 0, 0.35, rocket).rotation.x = Math.PI / 2; // nozzle
  for (let k = 0; k < 4; k++) {
    const fin = part(G.box, M.rocket, 0.02, 0.16, 0.2, 0, 0, 0.22, rocket);
    fin.rotation.z = (k / 4) * Math.PI * 2;
    fin.translateY(0.17);
  }
  const flame = part(G.flame, M.flame, 0.11, 0.11, 0.7, 0, 0, 0.4, rocket);
  const core = part(G.flame, M.core, 0.06, 0.06, 0.4, 0, 0, 0.4, rocket);

  // --- the orange -------------------------------------------------------------------------
  const guy = new THREE.Group();
  guy.position.set(0, 1.06, -0.04);
  kart.add(guy);
  const R = 0.43;
  part(G.sphere, M.orange, R, R * 0.96, R, 0, 0, 0, guy, true);
  part(G.capsule, M.leaf, 0.02, 0.05, 0.02, 0, R + 0.03, 0, guy); // stem
  const leaf = part(G.lowSphere, M.leaf, 0.09, 0.025, 0.05, 0.07, R + 0.03, 0.02, guy);
  leaf.rotation.z = -0.4;
  // backwards cap
  part(G.sphere, capMat, 0.27, 0.15, 0.27, 0, R - 0.02, 0.04, guy);
  const brim = part(G.cyl, capMat, 0.2, 0.02, 0.2, 0, R + 0.02, 0.27, guy);
  brim.scale.set(0.22, 0.02, 0.16);
  // sunglasses pushed up on the forehead
  const shades = new THREE.Group();
  shades.position.set(0, 0.31, -0.27);
  shades.rotation.x = 0.85;
  guy.add(shades);
  for (const s of [-1, 1]) {
    part(G.sphere, M.shades, 0.1, 0.065, 0.025, s * 0.115, 0, 0, shades); // rounded lenses
    const arm = part(G.box, M.shades, 0.012, 0.012, 0.2, s * 0.215, 0.01, 0.1, shades);
    arm.rotation.y = s * -0.25;
  }
  part(G.box, M.gold, 0.06, 0.015, 0.015, 0, 0.02, -0.005, shades); // gold bridge
  // googly eyes with a smug squint
  const pupils: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    part(G.sphere, M.white, 0.085, 0.1, 0.06, s * 0.13, 0.08, -0.39, guy);
    pupils.push(part(G.sphere, M.black, 0.04, 0.045, 0.03, s * 0.13 + 0.015, 0.07, -0.44, guy));
    const brow = part(G.box, M.black, 0.08, 0.018, 0.02, s * 0.13, 0.17, -0.4, guy);
    brow.rotation.z = s * 0.3; // one cocky raised look
  }
  // huge grin: dark mouth with a white row of teeth
  const smile = new THREE.Group();
  smile.position.set(0, -0.09, -0.36);
  guy.add(smile);
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), M.mouth); // lower half = grin shape
  mouth.scale.set(0.25, 0.13, 0.08);
  smile.add(mouth);
  const teeth = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 4), M.white);
  teeth.scale.set(0.235, 0.09, 0.085);
  teeth.position.y = -0.005;
  smile.add(teeth);
  // gold chain + coin
  // necklace: a ring around the lower half, dipping towards the front where the coin hangs
  const chain = part(G.torus, M.gold, 0.4, 0.4, 0.4, 0, -0.22, 0.02, guy);
  chain.rotation.x = Math.PI / 2 - 0.3;
  const coin = part(G.cyl, M.gold, 0.1, 0.02, 0.1, 0, -0.35, -0.4, guy);
  coin.rotation.x = Math.PI / 2;
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.095, 24), M.coin);
  face.position.set(0, -0.35, -0.412);
  face.rotation.y = Math.PI;
  guy.add(face);
  // little arms gripping the armrests, legs dangling
  for (const s of [-1, 1]) {
    const arm = part(G.capsule, M.orange, 0.045, 0.22, 0.045, s * 0.36, -0.2, -0.08, guy);
    arm.rotation.z = s * 0.6;
    part(G.sphere, M.orange, 0.06, 0.05, 0.07, s * 0.33, -0.31, -0.12, guy); // hand
    const leg = part(G.capsule, M.orange, 0.05, 0.2, 0.05, s * 0.14, -0.42, -0.3, guy);
    leg.rotation.x = 1.1;
    part(G.sphere, M.orange, 0.07, 0.05, 0.1, s * 0.14, -0.5, -0.46, guy); // foot
  }

  // far-away stand-in: an orange ball on a coloured seat (2 draw calls)
  const far = new THREE.Group();
  const fk = new THREE.Group();
  fk.scale.setScalar(S);
  far.add(fk);
  part(G.box, seatMat, 0.62, 0.5, 0.6, 0, 0.45, 0, fk);
  part(G.lowSphere, M.orange, R, R, R, 0, 1.06, -0.04, fk);

  let bob = 0;
  const animate = (t: number, speed: number) => {
    const k = Math.min(1, speed / 30);
    // flame flickers and grows with speed
    const f = 0.55 + k * 1.1 + Math.sin(t * 47) * 0.08 + Math.sin(t * 31) * 0.06;
    flame.scale.set(0.11 + k * 0.03, 0.11 + k * 0.03, 0.35 + f * 0.6);
    core.scale.set(0.06, 0.06, 0.2 + f * 0.3);
    flame.visible = core.visible = speed > 0.5;
    // the orange bounces on the seat and its eyes jiggle
    bob += 0.016 * (6 + k * 10);
    guy.position.y = 1.06 + Math.abs(Math.sin(bob)) * (0.015 + k * 0.03);
    guy.rotation.z = Math.sin(bob * 0.5) * 0.04 * k;
    for (const p of pupils) p.position.y = 0.07 + Math.sin(t * 9 + p.position.x * 10) * 0.008;
  };
  return { model, wheels, front, tail, far, animate };
}
