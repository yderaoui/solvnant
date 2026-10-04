// 3D spectators. One low-poly human (~450 triangles) instanced thousands of times and animated in
// the vertex shader: fans sit (legs bent at hip and knee), stand up when the action gets exciting,
// raise and wave their arms, jump, back away from a crash, and turn their heads to follow the cars.
// Fans far from the camera are drawn as camera-facing cards whose pictures are rendered from this
// same model at startup ("impostors"), so near and far fans match.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../sim/rng';

export const MAX_IMPACTS = 4;
export const MAX_CARS_UNIFORM = 10;
export const VARIANTS = 32;

// Looks: shirt, trousers, skin, hair (sRGB hex)
const SHIRTS = ['#c8102e', '#1f4fbf', '#f2f2f2', '#16181c', '#2e7d32', '#f4c20d', '#ef6c00', '#6a1b9a', '#0097a7', '#d81b60', '#8d8d8d', '#3b5f8a', '#7a1f1f', '#e8e2d0', '#1b5e20', '#8cff2e'];
const PANTS = ['#1d2a44', '#2b3a55', '#20232a', '#4a4a4a', '#6b5b45', '#2f3e5c', '#11141a'];
const SKINS = ['#f3d2b3', '#e8b48f', '#c98e64', '#a86b46', '#7b4a2c', '#5a3622'];
const HAIRS = ['#14110f', '#3a2618', '#6b4428', '#b98d4f', '#8a8a8a', '#5c2c1a'];

export interface Look {
  shirt: THREE.Color;
  pants: THREE.Color;
  skin: THREE.Color;
  hair: THREE.Color;
}

export const LOOKS: Look[] = (() => {
  const rng = new Rng(9001);
  const pick = (a: string[]) => new THREE.Color(a[Math.floor(rng.next() * a.length)]);
  return Array.from({ length: VARIANTS }, () => ({ shirt: pick(SHIRTS), pants: pick(PANTS), skin: pick(SKINS), hair: pick(HAIRS) }));
})();

/** Shared uniforms for the 3D fans and the far-away cards. */
export function crowdUniforms() {
  const cars: THREE.Vector3[] = [];
  for (let i = 0; i < MAX_CARS_UNIFORM; i++) cars.push(new THREE.Vector3(1e6, 1e6, 0));
  const impacts: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_IMPACTS; i++) impacts.push(new THREE.Vector4(0, 0, -99, 0));
  return {
    uTime: { value: 0 },
    uExcite: { value: 0 },
    uImpacts: { value: impacts },
    uCars: { value: cars },
  };
}
export type CrowdUniforms = ReturnType<typeof crowdUniforms>;

// Body groups that move as one piece (aPart) and which colour each vertex takes (aMat).
const P = { body: 0, armL: 1, armR: 2, head: 3, thigh: 4, shin: 5 };
const M = { shirt: 0, skin: 1, pants: 2, shoes: 3, hair: 4 };

/** The human mesh: feet at the origin, facing +Z, ~1.75 m tall. */
export function humanGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, part: number, mat: number) => {
    g = g.index ? g.toNonIndexed() : g;
    g.deleteAttribute('uv');
    const n = g.getAttribute('position').count;
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array(n).fill(part), 1));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(new Array(n).fill(mat), 1));
    parts.push(g);
  };
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.11, 0.07, 0.25).translate(s * 0.1, 0.035, 0.03), P.shin, M.shoes);
    add(new THREE.CylinderGeometry(0.055, 0.045, 0.42, 6).translate(s * 0.1, 0.26, 0), P.shin, M.pants);
    add(new THREE.CylinderGeometry(0.075, 0.06, 0.42, 6).translate(s * 0.1, 0.67, 0), P.thigh, M.pants);
    const arm = s < 0 ? P.armL : P.armR;
    add(new THREE.CylinderGeometry(0.052, 0.046, 0.3, 6).translate(s * 0.225, 1.25, 0), arm, M.shirt);
    add(new THREE.CylinderGeometry(0.044, 0.038, 0.27, 6).translate(s * 0.225, 0.96, 0), arm, M.skin);
    add(new THREE.SphereGeometry(0.045, 6, 4).translate(s * 0.225, 0.8, 0), arm, M.skin);
  }
  add(new THREE.CylinderGeometry(0.16, 0.15, 0.16, 8).scale(1, 1, 0.65).translate(0, 0.88, 0), P.body, M.pants);
  add(new THREE.CylinderGeometry(0.19, 0.155, 0.52, 8).scale(1, 1, 0.62).translate(0, 1.17, 0), P.body, M.shirt);
  add(new THREE.SphereGeometry(0.19, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.35, 0.62).translate(0, 1.42, 0), P.body, M.shirt);
  add(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 6).translate(0, 1.48, 0), P.head, M.skin);
  add(new THREE.SphereGeometry(0.105, 10, 8).scale(1, 1.18, 1.05).translate(0, 1.62, 0), P.head, M.skin);
  add(new THREE.SphereGeometry(0.113, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1, 1.15, 1.08).translate(0, 1.635, -0.01), P.head, M.hair);
  return mergeGeometries(parts)!;
}

const SHARED_GLSL = /* glsl */ `
  attribute vec3 aOffset;
  attribute vec2 aDir;    // direction away from the track (fans face the other way)
  attribute float aVar;
  attribute float aPhase;
  attribute float aSeat;  // 1 = sitting in a grandstand
  uniform float uTime;
  uniform float uExcite;
  uniform vec4 uImpacts[${MAX_IMPACTS}];
  uniform vec3 uCars[${MAX_CARS_UNIFORM}];
  float crowdExcite(vec3 base, out float flee, out vec2 nearCar) {
    float excite = uExcite * (0.6 + 0.4 * fract(aPhase * 13.7));
    float best = 1e9;
    nearCar = base.xz + vec2(0.0, 50.0);
    for (int i = 0; i < ${MAX_CARS_UNIFORM}; i++) {
      float d = distance(base.xz, uCars[i].xy);
      excite = max(excite, smoothstep(28.0, 6.0, d) * uCars[i].z * 0.8);
      if (d < best) { best = d; nearCar = uCars[i].xy; }
    }
    flee = 0.0;
    for (int i = 0; i < ${MAX_IMPACTS}; i++) {
      vec4 im = uImpacts[i];
      float age = uTime - im.z;
      if (age > 0.0 && age < 5.0) {
        float k = smoothstep(18.0, 3.0, distance(base.xz, im.xy)) * im.w;
        excite = max(excite, k);
        flee = max(flee, k * min(age * 2.0, 1.0) * (1.0 - smoothstep(3.0, 5.0, age)));
      }
    }
    return excite;
  }
  bool hiddenByCamera(vec3 base) {
    // the fan whose eyes we are looking through (and the ones right next to them) aren't drawn
    return distance(base.xz, cameraPosition.xz) < 1.2 && abs(base.y + 1.2 - cameraPosition.y) < 1.6;
  }
`;

/**
 * Lit 3D fans: a MeshStandardMaterial with the body animation injected into its vertex shader,
 * so they get the same lights, environment and fog as everything else.
 */
export function humanMaterial(u: CrowdUniforms, bake = false): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        ${SHARED_GLSL}
        attribute float aPart;
        attribute float aMat;
        attribute vec3 aShirt;
        attribute vec3 aPants;
        attribute vec3 aSkin;
        attribute vec3 aHair;
        attribute float aPose; // bake only: 0 arms down, 1 arms up
        mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
        mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
        mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
        vec3 hBase; float hYaw; float hSeat; float hArm; float hArmFwd; float hHead; float hHide;
        // move one point (or normal: w = 0) of the body into its pose
        vec3 pose(vec3 p, float w) {
          vec3 hip = vec3(p.x, 0.88, 0.0), knee = vec3(p.x, 0.46, 0.0);
          if (aPart > 4.5) p = knee * w + rotX(hSeat * 1.5) * (p - knee * w);
          if (aPart > 3.5) p = hip * w + rotX(-hSeat * 1.5) * (p - hip * w);
          if (aPart > 0.5 && aPart < 2.5) {
            float side = aPart < 1.5 ? -1.0 : 1.0;
            vec3 sh = vec3(side * 0.225, 1.4, 0.0);
            p = sh * w + rotX(-hArmFwd) * rotZ(side * hArm) * (p - sh * w);
          }
          if (aPart > 2.5 && aPart < 3.5) {
            vec3 neck = vec3(0.0, 1.47, 0.0);
            p = neck * w + rotY(hHead) * (p - neck * w);
          }
          p.y -= hSeat * 0.42 * w;
          return rotY(hYaw) * p;
        }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `
        hBase = aOffset;
        float flee; vec2 nearCar;
        float excite = crowdExcite(hBase, flee, nearCar);
        hBase.xz += aDir * flee * 3.5;
        // sitting fans get up when it gets exciting
        hSeat = aSeat * (1.0 - smoothstep(0.5, 0.75, excite));
        float up = smoothstep(0.35, 0.6, excite) * (0.65 + 0.35 * sin(uTime * 6.0 + aPhase * 30.0));
        hArm = mix(0.12 + 0.05 * sin(uTime * 1.3 + aPhase * 9.0), 2.75, up);
        hArmFwd = 0.35 * up;
        hBase.y += max(0.0, sin(uTime * (7.0 + aPhase * 4.0) + aPhase * 40.0)) * 0.18 * excite * (1.0 - hSeat);
        vec2 face = -aDir;
        hYaw = atan(face.x, face.y);
        // look at the nearest car (heads turn up to ~75 degrees)
        vec2 toCar = normalize(nearCar - hBase.xz);
        hHead = clamp(atan(face.x * toCar.y - face.y * toCar.x, dot(face, toCar)), -1.3, 1.3) * -1.0;
        ${bake ? 'hSeat = 0.0; hArm = mix(0.12, 2.75, aPose); hArmFwd = 0.35 * aPose; hHead = 0.0; hBase = aOffset; hYaw = 0.0;' : ''}
        hHide = ${bake ? '0.0' : 'hiddenByCamera(hBase) ? 1.0 : 0.0'};
        vec3 objectNormal = pose(normal, 0.0);
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(1.0, 0.0, 0.0);
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = pose(position, 1.0) + hBase;
        if (hHide > 0.5) transformed = vec3(0.0, -1000.0, 0.0);`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        vColor = aMat < 0.5 ? aShirt : aMat < 1.5 ? aSkin : aMat < 2.5 ? aPants : aMat < 3.5 ? vec3(0.03) : aHair;`,
      );
  };
  mat.customProgramCacheKey = () => (bake ? 'human-bake' : 'human');
  return mat;
}

/** Camera-facing cards for far-away fans, textured with the baked impostor atlas. */
export function cardMaterial(u: CrowdUniforms, atlas: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...u, uAtlas: { value: atlas }, uLight: { value: 1.0 } },
    vertexShader: /* glsl */ `
      ${SHARED_GLSL}
      varying vec2 vUv;
      varying float vShade;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vec3 base = aOffset;
        float flee; vec2 nearCar;
        float excite = crowdExcite(base, flee, nearCar);
        base.xz += aDir * flee * 3.5;
        base.y += max(0.0, sin(uTime * (7.0 + aPhase * 4.0) + aPhase * 40.0)) * 0.18 * excite * (1.0 - aSeat);
        base.y -= aSeat * 0.42 * (1.0 - smoothstep(0.5, 0.75, excite));
        if (hiddenByCamera(base)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        vec2 toCam = normalize(cameraPosition.xz - base.xz);
        vec3 right = vec3(toCam.y, 0.0, -toCam.x);
        vec3 p = base + right * (position.x) + vec3(0.0, position.y, 0.0);
        float arms = step(0.4, excite) * step(-0.3, sin(uTime * 2.5 + aPhase * 17.0));
        vUv = vec2((mod(aVar, ${VARIANTS}.0) + uv.x) / ${VARIANTS}.0, (uv.y + arms) / 2.0);
        vShade = 0.85 + 0.15 * fract(aPhase * 7.31);
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
}

/** Per-instance colour attributes for a list of look variants. */
export function lookAttributes(vars: ArrayLike<number>) {
  const n = vars.length;
  const shirt = new Float32Array(n * 3),
    pants = new Float32Array(n * 3),
    skin = new Float32Array(n * 3),
    hair = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const L = LOOKS[vars[i] % VARIANTS];
    L.shirt.toArray(shirt, i * 3);
    L.pants.toArray(pants, i * 3);
    L.skin.toArray(skin, i * 3);
    L.hair.toArray(hair, i * 3);
  }
  return { shirt, pants, skin, hair };
}

/** Card size in metres (the baked picture covers this much of the person). */
export const CARD_W = 0.9;
export const CARD_H = 1.9;

/**
 * Render every look, arms down (bottom row) and arms up (top row), into one texture so far-away
 * cards show the same people as the 3D fans up close.
 */
export function bakeAtlas(gl: THREE.WebGLRenderer, u: CrowdUniforms): THREE.Texture {
  const cellW = 64,
    cellH = 128;
  const rt = new THREE.WebGLRenderTarget(cellW * VARIANTS, cellH * 2, { samples: 4 });
  rt.texture.generateMipmaps = true;
  rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3328, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(0.6, 1.2, 2);
  scene.add(key);
  const n = VARIANTS * 2;
  const geo = new THREE.InstancedBufferGeometry().copy(humanGeometry() as unknown as THREE.InstancedBufferGeometry);
  const off = new Float32Array(n * 3),
    dir = new Float32Array(n * 2),
    vr = new Float32Array(n),
    pose = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = i % VARIANTS,
      row = Math.floor(i / VARIANTS);
    off.set([(v + 0.5) * CARD_W, row * CARD_H + 0.03, 0], i * 3);
    dir.set([0, -1], i * 2);
    vr[i] = v;
    pose[i] = row;
  }
  const looks = lookAttributes(vr);
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
  geo.setAttribute('aDir', new THREE.InstancedBufferAttribute(dir, 2));
  geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(vr, 1));
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
  geo.setAttribute('aSeat', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
  geo.setAttribute('aPose', new THREE.InstancedBufferAttribute(pose, 1));
  geo.setAttribute('aShirt', new THREE.InstancedBufferAttribute(looks.shirt, 3));
  geo.setAttribute('aPants', new THREE.InstancedBufferAttribute(looks.pants, 3));
  geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(looks.skin, 3));
  geo.setAttribute('aHair', new THREE.InstancedBufferAttribute(looks.hair, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count * 3).fill(1), 3));
  geo.instanceCount = n;
  const mesh = new THREE.Mesh(geo, humanMaterial(u, true));
  mesh.frustumCulled = false;
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(0, VARIANTS * CARD_W, 2 * CARD_H, 0, -10, 10);
  cam.position.z = 5;
  const prevTarget = gl.getRenderTarget();
  const prevClear = gl.getClearColor(new THREE.Color());
  const prevAlpha = gl.getClearAlpha();
  gl.setRenderTarget(rt);
  gl.setClearColor(0x000000, 0);
  gl.clear();
  gl.render(scene, cam);
  gl.setRenderTarget(prevTarget);
  gl.setClearColor(prevClear, prevAlpha);
  geo.dispose();
  return rt.texture;
}
