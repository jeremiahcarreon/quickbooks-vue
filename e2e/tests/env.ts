import { fileURLToPath } from 'node:url';

/** Where the dev stack's web container listens (nginx, proxies /api). */
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8180';
/** The relay mock's host port in compose.dev.yaml (control endpoints for checks). */
export const RELAY_MOCK_URL = process.env.E2E_RELAY_MOCK_URL ?? 'http://127.0.0.1:9223';
export const RELAY_API_KEY = process.env.RELAY_API_KEY ?? 'dev-relay-key';

/** Same variables (and dev defaults) as the migrate service in compose.dev.yaml. */
export const ADMIN_EMAIL =
  process.env.E2E_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@example.com';
export const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'dev-admin-password';

export const STORAGE_STATE = fileURLToPath(new URL('../.auth/admin.json', import.meta.url));
export const RUN_INFO = fileURLToPath(new URL('../.auth/run.json', import.meta.url));

/** A suffix that keeps names unique across runs against the same company file. */
export const RUN_ID = (process.env.E2E_RUN_ID ?? Date.now().toString(36)).toUpperCase();
