import type { Db } from './client.js';
import { jsonb } from './json.js';
import type { ActorType, AuditLogRow, JsonValue } from './schema.js';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  /** e.g. `object.add`, `object.mod`, `qbxml.raw`, `auth.login`, `admin.user.update`. */
  action: string;
  objectType?: string | null;
  objectId?: string | null;
  commandId?: string | null;
  ip?: string | null;
  detail?: JsonValue;
}

/** Append one audit row. Returns its id. */
export async function writeAudit(db: Db, e: AuditEntry): Promise<string> {
  const row = await db
    .insertInto('audit_log')
    .values({
      actor_type: e.actorType,
      actor_id: e.actorId ?? null,
      action: e.action,
      object_type: e.objectType ?? null,
      object_id: e.objectId ?? null,
      command_id: e.commandId ?? null,
      ip: e.ip ?? null,
      detail: jsonb(e.detail ?? {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return String(row.id);
}

export interface ListAuditQuery {
  actorType?: ActorType;
  actorId?: string;
  action?: string;
  objectType?: string;
  objectId?: string;
  commandId?: string;
  /** Keyset cursor: rows with id < before. */
  before?: string | number;
  limit?: number;
}

export async function listAudit(db: Db, q: ListAuditQuery = {}): Promise<AuditLogRow[]> {
  let query = db.selectFrom('audit_log').selectAll();
  if (q.actorType) query = query.where('actor_type', '=', q.actorType);
  if (q.actorId) query = query.where('actor_id', '=', q.actorId);
  if (q.action) query = query.where('action', '=', q.action);
  if (q.objectType) query = query.where('object_type', '=', q.objectType);
  if (q.objectId) query = query.where('object_id', '=', q.objectId);
  if (q.commandId) query = query.where('command_id', '=', q.commandId);
  if (q.before !== undefined) query = query.where('id', '<', String(q.before));
  return query
    .orderBy('id', 'desc')
    .limit(Math.min(Math.max(1, q.limit ?? 100), 1000))
    .execute();
}
