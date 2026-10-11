import * as THREE from 'three';
import type { Track } from '../sim/track';
import { PHYS } from '../sim/physics';
import { Rng } from '../sim/rng';

/** Static city dressing: instanced skyline/windows, emissive signage, no extra dynamic lights. */
export function buildTokyoCity(track: Track): THREE.Group {
  const city = new THREE.Group();
  const rng = Rng.fromString('tokyo-city:' + track.seed);
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#171728'; ctx.fillRect(0, 0, 128, 256);
  for (let y = 8; y < 256; y += 16) for (let x = 8; x < 128; x += 16) {
    ctx.fillStyle = rng.next() > 0.3 ? ['#31e4e5', '#e993cd', '#f8da9c'][rng.int(0, 2)] : '#252636';
    ctx.fillRect(x, y, 6, 8);
  }
  const windows = new THREE.CanvasTexture(canvas); windows.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardMaterial({ map: windows, emissiveMap: windows, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.7 });
  const plots: { x: number; z: number; w: number; d: number; h: number }[] = [];
  const bounds = track.bounds;
  for (let x = bounds.minX - 210; x < bounds.maxX + 210; x += 48) {
    for (let z = bounds.minY - 210; z < bounds.maxY + 210; z += 48) {
      const w = rng.range(20, 33), d = rng.range(20, 33);
      const clearance = Math.max(...track.widths) / 2 + PHYS.runoff + Math.hypot(w, d) / 2 + 14;
      if (track.points.some(p => Math.hypot(p[0] - x, p[1] - z) < clearance)) continue;
      plots.push({ x, z, w, d, h: rng.range(24, 115) });
    }
  }
  const buildings = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, plots.length);
  const matrix = new THREE.Matrix4();
  plots.forEach((plot, i) => {
    matrix.compose(new THREE.Vector3(plot.x, plot.h / 2, plot.z), new THREE.Quaternion(), new THREE.Vector3(plot.w, plot.h, plot.d));
    buildings.setMatrixAt(i, matrix);
    buildings.setColorAt(i, new THREE.Color().setHSL(rng.range(0.58, 0.76), 0.2, rng.range(0.65, 0.9)));
  });
  city.add(buildings);

  const pink = new THREE.MeshBasicMaterial({ color: 0xff087f });
  const cyan = new THREE.MeshBasicMaterial({ color: 0x20efff });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x292333, roughness: 0.8 });
  const count = Math.ceil(track.points.length / 4) * 2;
  const rails = new THREE.InstancedMesh(new THREE.BoxGeometry(track.spacing * 4.2, 0.12, 0.18), pink, count);
  let rail = 0;
  for (let i = 0; i < track.points.length; i += 4) for (const side of [-1, 1]) {
    const h = track.headings[i], dist = side * (track.widths[i] / 2 + PHYS.runoff);
    matrix.compose(new THREE.Vector3(track.points[i][0] - Math.sin(h) * dist, 0.95, track.points[i][1] + Math.cos(h) * dist), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -h), new THREE.Vector3(1, 1, 1));
    rails.setMatrixAt(rail++, matrix);
  }
  rails.count = rail; city.add(rails);

  const texts = ['TOKYO AFTERDARK', 'PUMPKART', 'MIDNIGHT RUN', 'NEON DISTRICT', 'FULL THROTTLE'];
  for (let i = 0, sign = 0; i < track.points.length; i += 19, sign++) {
    const h = track.headings[i], side = sign % 2 ? 1 : -1, dist = side * (track.widths[i] / 2 + PHYS.runoff + 6);
    const group = new THREE.Group(); group.position.set(track.points[i][0] - Math.sin(h) * dist, 0, track.points[i][1] + Math.cos(h) * dist); group.rotation.y = -h;
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.5, 12, 0.5), concrete); pole.position.y = 6;
    const panel = document.createElement('canvas'); panel.width = 512; panel.height = 128;
    const context = panel.getContext('2d')!; context.fillStyle = '#0a0617'; context.fillRect(0,0,512,128);
    context.strokeStyle = sign % 2 ? '#20efff' : '#ff087f'; context.lineWidth = 8; context.strokeRect(4,4,504,120);
    context.fillStyle = '#ffffff'; context.font = 'bold 34px sans-serif'; context.textAlign = 'center'; context.fillText(texts[sign % texts.length],256,77);
    const texture = new THREE.CanvasTexture(panel); texture.colorSpace = THREE.SRGBColorSpace;
    const billboard = new THREE.Mesh(new THREE.PlaneGeometry(15, 3.75), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
    billboard.position.y = 11; billboard.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    group.add(pole, billboard); city.add(group);
  }
  // A lit gateway marks the start boulevard, with generous clearance above racers.
  const gate = new THREE.Group(); const p = track.points[0]; gate.position.set(p[0], 0, p[1]); gate.rotation.y = -track.headings[0];
  const width = track.widths[0] + 6;
  for (const side of [-1, 1]) {
    const upright = new THREE.Mesh(new THREE.BoxGeometry(1, 9, 1), cyan); upright.position.set(0, 4.5, side * width / 2); gate.add(upright);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(1, 0.6, width + 1), cyan); beam.position.y = 9; gate.add(beam); city.add(gate);
  return city;
}
