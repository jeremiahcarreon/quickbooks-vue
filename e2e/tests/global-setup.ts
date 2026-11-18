import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { request, type FullConfig } from '@playwright/test';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  BASE_URL,
  RELAY_API_KEY,
  RELAY_MOCK_URL,
  RUN_INFO,
  STORAGE_STATE,
} from './env.js';

/**
 * Logs in once through the API (the login screen itself is covered by
 * auth.spec.ts), stores the session for every test, and records when the
 * run started: the final spec asserts that the relay mock logged no XSD or
 * well-formedness rejection after that moment.
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const health = await ctx.get('/api/health');
  if (!health.ok()) {
    throw new Error(
      `The dev stack is not healthy at ${BASE_URL} (GET /api/health -> ${health.status()}). Start it with npm run dev:up.`,
    );
  }
  const login = await ctx.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!login.ok()) {
    throw new Error(
      `Admin login failed (${login.status()}). Set E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD (or ADMIN_EMAIL / ADMIN_PASSWORD) to the stack's admin.`,
    );
  }
  await ctx.storageState({ path: STORAGE_STATE });
  await ctx.dispose();

  const mock = await request.newContext({
    baseURL: RELAY_MOCK_URL,
    extraHTTPHeaders: { 'x-api-key': RELAY_API_KEY },
  });
  const state = await mock.get('/qb/health');
  await mock.dispose();
  if (!state.ok()) {
    throw new Error(`The relay mock is not reachable at ${RELAY_MOCK_URL} (${state.status()}).`);
  }
  writeFileSync(RUN_INFO, JSON.stringify({ startedAt: new Date().toISOString() }));
}
