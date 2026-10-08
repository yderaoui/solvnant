# Racer models

Original exports (Tripo GLBs, 60+ MB each) go here as `<name>-source.glb`. They are gitignored; only the
optimized copies in `public/assets/characters/` ship.

Adding a racer:

1. Optimize (near model ~600 KB, far model ~150 KB):

   ```sh
   npx @gltf-transform/cli@4 optimize characters/<name>-source.glb public/assets/characters/<name>.glb --compress meshopt --texture-compress webp --texture-size 1024 --simplify true --simplify-ratio 0.016 --simplify-error 0.004
   npx @gltf-transform/cli@4 optimize characters/<name>-source.glb public/assets/characters/<name>-far.glb --compress meshopt --texture-compress webp --texture-size 256 --simplify true --simplify-ratio 0.0015 --simplify-error 0.02
   ```

2. Add it to `SKINS` in `src/game/skins.ts`. `yaw` turns the model to face +X; `exhaust` sets where the flames sit; `price` is in the game coin (0 = free).
3. Render a 960x720 transparent `public/assets/characters/<name>.webp` thumbnail for the garage, three-quarter front view.
4. Deploy the game server (`npx wrangler deploy`) as well as the site: prices and ownership are checked there.
