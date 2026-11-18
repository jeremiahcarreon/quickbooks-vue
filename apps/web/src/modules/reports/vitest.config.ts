/**
 * Test config for the reports module. It reuses the web app's Vite config and
 * points at this module's tests:
 *
 *   npx vitest run --config src/modules/reports/vitest.config.ts   (from apps/web)
 */
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import base from '../../../vite.config';

export default defineConfig({
  ...base,
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: {
    ...base.test,
    include: ['src/modules/reports/**/*.test.ts'],
  },
});
