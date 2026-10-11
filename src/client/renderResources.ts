import type { Material, Object3D, Mesh } from 'three';

// Geometry and textures belong to the cached model. Only these materials belong to one racer.
const ownedMaterials = new WeakSet<Material>();
export function ownRacerMaterial<T extends Material>(material: T): T {
  ownedMaterials.add(material);
  return material;
}
export const isOwnedRacerMaterial = (material: Material) => ownedMaterials.has(material);

export function disposeRacerMaterials(root: Object3D) {
  const disposed = new Set<Material>();
  root.traverse(object => {
    const value = (object as Mesh).material;
    for (const material of Array.isArray(value) ? value : value ? [value] : []) {
      if (!ownedMaterials.has(material) || disposed.has(material)) continue;
      disposed.add(material);
      material.dispose();
    }
  });
}
