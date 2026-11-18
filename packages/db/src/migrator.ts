import { Migrator, type MigrationResultSet, type MigrationInfo } from 'kysely';
import type { Db } from './client.js';
import { migrations } from './migrations/index.js';

export function createMigrator(db: Db): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  });
}

function unwrap(res: MigrationResultSet): MigrationResultSet {
  if (res.error) {
    const failed = res.results?.find((r) => r.status === 'Error');
    const err = res.error instanceof Error ? res.error : new Error(String(res.error));
    if (failed) err.message = `Migration ${failed.migrationName} failed: ${err.message}`;
    throw err;
  }
  return res;
}

export async function migrateToLatest(db: Db): Promise<MigrationResultSet> {
  return unwrap(await createMigrator(db).migrateToLatest());
}

export async function migrateUp(db: Db): Promise<MigrationResultSet> {
  return unwrap(await createMigrator(db).migrateUp());
}

export async function migrateDown(db: Db): Promise<MigrationResultSet> {
  return unwrap(await createMigrator(db).migrateDown());
}

export async function migrationStatus(db: Db): Promise<readonly MigrationInfo[]> {
  return createMigrator(db).getMigrations();
}
