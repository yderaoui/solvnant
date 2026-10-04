import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  // Pre-bundle the lazily imported 3D view so the dev server doesn't re-optimize (and reload) on first use.
  optimizeDeps: { include: ['quickjs-emscripten-core', '@jitl/quickjs-singlefile-mjs-release-sync', 'pixi.js', '@supabase/supabase-js', 'three', 'three/examples/jsm/postprocessing/EffectComposer.js', 'three/examples/jsm/postprocessing/RenderPass.js', 'three/examples/jsm/postprocessing/UnrealBloomPass.js', 'three/examples/jsm/postprocessing/OutputPass.js', 'three/examples/jsm/utils/BufferGeometryUtils.js', 'three/examples/jsm/loaders/GLTFLoader.js', 'three/examples/jsm/loaders/DRACOLoader.js', 'three/examples/jsm/loaders/HDRLoader.js'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { testTimeout: 60_000, exclude: ['**/node_modules/**', '.claude/**', 'onchain/**'] },
} as any);
