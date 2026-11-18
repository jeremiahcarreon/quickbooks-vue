import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// Dev server on 5273; /api is proxied to the api service (default 127.0.0.1:3100,
// override with VITE_API_PROXY). SSE needs no buffering, which Vite's proxy does not do.
const apiTarget = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:3100';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false, ws: false },
    },
  },
  preview: { host: '127.0.0.1', port: 5273, strictPort: true },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'src/**/*.{test,spec}.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
