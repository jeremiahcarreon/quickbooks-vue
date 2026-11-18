import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, STORAGE_STATE } from './tests/env.js';

/**
 * End-to-end tests against the running dev stack:
 *   npm run dev:up          (compose.yaml + compose.dev.yaml, relay-mock seeded)
 *   npm run test:e2e
 * The tests share one QuickBooks (the relay mock) and one read model, so they
 * run serially.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './tests/global-setup.ts',
  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 900 },
  },
});
