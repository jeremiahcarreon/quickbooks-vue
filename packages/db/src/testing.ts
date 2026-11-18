import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { testDatabaseUrl } from '@qbv/config/testing';
import { createDb, type Db } from './client.js';
import { migrateToLatest } from './migrator.js';

export interface TestDatabase {
  db: Db;
  /** Connection string of the throwaway database. */
  url: string;
  name: string;
  /** Close the pool and drop the database. */
  destroy(): Promise<void>;
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * Create an isolated, migrated database on the test server
 * (TEST_DATABASE_URL, default 127.0.0.1:55433 from `npm run infra:up`).
 * Use one per test file: `const t = await createTestDatabase(); afterAll(() => t.destroy())`.
 */
export async function createTestDatabase(
  opts: { baseUrl?: string; migrate?: boolean; prefix?: string } = {},
): Promise<TestDatabase> {
  const baseUrl = opts.baseUrl ?? testDatabaseUrl();
  const name = `${opts.prefix ?? 'qbv_t'}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach the test Postgres at ${baseUrl.replace(/:[^:@/]*@/, ':***@')}. ` +
        `Start it with \`npm run infra:up\` (or set TEST_DATABASE_URL). Cause: ${(err as Error).message}`,
    );
  }
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(baseUrl, name);
  const db = createDb({ connectionString: url, max: 5, applicationName: 'qbv-test' });
  if (opts.migrate !== false) await migrateToLatest(db);
  return {
    db,
    url,
    name,
    async destroy() {
      await db.destroy();
      const c = new pg.Client({ connectionString: baseUrl });
      await c.connect();
      try {
        await c.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await c.end();
      }
    },
  };
}
