import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

const DATE_OID = 1082;
let parsersInstalled = false;

/** Keep `date` values as YYYY-MM-DD strings instead of local-midnight Dates. */
export function installTypeParsers(): void {
  if (parsersInstalled) return;
  pg.types.setTypeParser(DATE_OID, (v: string) => v);
  parsersInstalled = true;
}

export interface CreateDbOptions {
  connectionString: string;
  /** Pool size (default 10). */
  max?: number;
  ssl?: boolean;
  applicationName?: string;
}

export type Db = Kysely<Database>;

export function createDb(opts: CreateDbOptions | string): Db {
  installTypeParsers();
  const o = typeof opts === 'string' ? { connectionString: opts } : opts;
  const pool = new pg.Pool({
    connectionString: o.connectionString,
    max: o.max ?? 10,
    ssl: o.ssl ? { rejectUnauthorized: false } : undefined,
    application_name: o.applicationName ?? 'qbv',
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Build a Kysely instance from a loaded @qbv/config service config. */
export function createDbFromConfig(
  config: { DATABASE_URL: string; DATABASE_POOL_MAX: number; DATABASE_SSL: boolean },
  applicationName?: string,
): Db {
  return createDb({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL,
    applicationName,
  });
}
