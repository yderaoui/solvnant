import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  // Pre-bundle the lazily imported 3D view so the dev server doesn't re-optimize (and reload) on first use.
  optimizeDeps: { include: ['three', 'three/examples/jsm/postprocessing/EffectComposer.js', 'three/examples/jsm/postprocessing/RenderPass.js', 'three/examples/jsm/postprocessing/UnrealBloomPass.js', 'three/examples/jsm/postprocessing/OutputPass.js'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { testTimeout: 60_000 },
} as any);
