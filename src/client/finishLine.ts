import * as THREE from 'three';

/** Two lightweight fabric flags outside the road; no physics, shadows or extra lights. */
export class FinishFlags {
  readonly group = new THREE.Group();
  private flags: { pivot: THREE.Group; fabric: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> }[] = [];
  private waveAt = -Infinity;
  private wasMoving = false;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(point: [number, number], heading: number, width: number) {
    this.group.name = 'checkered-finish-flags';
    this.group.position.set(point[0], 0, point[1]);
    this.group.rotation.y = -heading;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 192;
    const ctx = canvas.getContext('2d')!;
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#080808' : '#ffffff';
      ctx.fillRect(x * 32, y * 32, 32, 32);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false });
    const steel = new THREE.MeshStandardMaterial({ color: 0xe2e7ed, metalness: 0.7, roughness: 0.35 });
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(-0.8, 4.8, side * (width / 2 + 2.4));
      pivot.rotation.y = -side * Math.PI / 2;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 4, 8), steel);
      pole.position.y = 0.6;
      const fabric = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.4, 24, 12), mat);
      fabric.position.set(1.6, 1.4, 0);
      // Bounds include the maximum ripple; avoid flags popping out under frustum culling.
      fabric.geometry.computeBoundingSphere();
      fabric.geometry.boundingSphere!.radius += 0.5;
      pivot.add(pole, fabric);
      this.flags.push({ pivot, fabric });
      this.group.add(pivot);
    }
  }

  wave(time: number) { this.waveAt = time; }

  update(time: number) {
    const age = time - this.waveAt;
    const moving = !this.reducedMotion.matches && age >= 0 && age < 3;
    if (!moving && !this.wasMoving) return;
    const strength = moving ? Math.sin(Math.min(1, age / 0.15) * Math.PI / 2) * Math.min(1, (3 - age) / 0.6) : 0;
    this.flags.forEach(({ pivot, fabric }, i) => {
      pivot.rotation.x = Math.sin(age * 7 + i * 0.6) * strength * 0.35;
      if (!moving) pivot.rotation.x = 0;
      const positions = fabric.geometry.attributes.position;
      for (let v = 0; v < positions.count; v++) {
        const x = positions.getX(v) + 1.6;
        positions.setZ(v, moving ? Math.sin(x * 3.2 - age * 11 + i) * (x / 3.2) * 0.38 * strength : 0);
      }
      positions.needsUpdate = true;
    });
    this.wasMoving = moving;
  }
}
