/**
 * Test config for the transactions, centers and home modules. It reuses the
 * web app's Vite config and adds the module test folders.
 *
 *   npx vitest run --config src/modules/transactions/vitest.config.ts   (from apps/web)
 *
 * Tests that build qbXML run in the node environment (`@vitest-environment node`)
 * because @qbv/qbxml validates with libxml2 against the XSDs on disk.
 */
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import base from '../../../vite.config';

export default defineConfig({
  ...base,
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: {
    ...base.test,
    include: ['src/modules/{transactions,centers,home}/**/*.test.ts'],
  },
});
