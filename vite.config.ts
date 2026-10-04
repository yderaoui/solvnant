import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { testTimeout: 60_000 },
} as any);
