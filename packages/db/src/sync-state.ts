import { sql } from 'kysely';
import type { Db } from './client.js';
import type { SyncStateRow } from './schema.js';

export interface SyncStatePatch {
  lastModifiedCursor?: Date | string | null;
  lastFullSyncAt?: Date | string | null;
  lastReconcileAt?: Date | string | null;
  lastRunAt?: Date | string | null;
  status?: string;
  error?: string | null;
  rowCount?: number;
}

export async function getSyncState(db: Db, type: string): Promise<SyncStateRow | undefined> {
  return db.selectFrom('sync_state').selectAll().where('type', '=', type).executeTakeFirst();
}

export async function listSyncStates(db: Db): Promise<SyncStateRow[]> {
  return db.selectFrom('sync_state').selectAll().orderBy('type').execute();
}

/** Insert or update one entity's sync state; only the given fields change. */
export async function upsertSyncState(
  db: Db,
  type: string,
  patch: SyncStatePatch,
): Promise<SyncStateRow> {
  const v: Record<string, unknown> = {};
  if (patch.lastModifiedCursor !== undefined) v.last_modified_cursor = patch.lastModifiedCursor;
  if (patch.lastFullSyncAt !== undefined) v.last_full_sync_at = patch.lastFullSyncAt;
  if (patch.lastReconcileAt !== undefined) v.last_reconcile_at = patch.lastReconcileAt;
  if (patch.lastRunAt !== undefined) v.last_run_at = patch.lastRunAt;
  if (patch.status !== undefined) v.status = patch.status;
  if (patch.error !== undefined) v.error = patch.error;
  if (patch.rowCount !== undefined) v.row_count = patch.rowCount;
  return db
    .insertInto('sync_state')
    .values({ type, ...v })
    .onConflict((oc) => oc.column('type').doUpdateSet({ ...v, updated_at: sql`now()` }))
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Forget a type's cursor so the next run does a full load. */
export async function resetSyncState(db: Db, type: string): Promise<void> {
  await upsertSyncState(db, type, {
    lastModifiedCursor: null,
    lastFullSyncAt: null,
    status: 'idle',
    error: null,
  });
}
