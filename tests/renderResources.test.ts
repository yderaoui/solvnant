import { expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Texture } from 'three';
import { disposeRacerMaterials, ownRacerMaterial } from '../src/client/renderResources';

it('releases racer materials once without damaging cached meshes or shared textures', () => {
  const geometry = new BoxGeometry(), texture = new Texture();
  const shared = new MeshBasicMaterial({ map: texture });
  const owned = ownRacerMaterial(shared.clone());
  const secondRacer = ownRacerMaterial(shared.clone());
  const root = new Group(); root.add(new Mesh(geometry, owned), new Mesh(geometry, [owned, shared]));
  const disposals = [owned, shared, secondRacer, texture, geometry].map(value => vi.spyOn(value, 'dispose'));
  disposeRacerMaterials(root);
  expect(disposals[0]).toHaveBeenCalledTimes(1);
  for (const dispose of disposals.slice(1)) expect(dispose).not.toHaveBeenCalled();
  expect(secondRacer.map).toBe(texture);
});
