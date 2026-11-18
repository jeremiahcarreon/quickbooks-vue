import type {
  ApiTokenRow,
  AppUserRow,
  AuditLogRow,
  CommandRow,
  QbObjectRow,
  RoleRow,
  SyncStateRow,
} from '@qbv/db';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function objectView(r: QbObjectRow) {
  return {
    type: r.type,
    id: r.qb_id,
    editSequence: r.edit_sequence,
    name: r.name,
    refNumber: r.ref_number,
    txnDate: r.txn_date,
    entityRefId: r.entity_ref_id,
    amount: r.amount,
    isActive: r.is_active,
    timeCreated: iso(r.time_created),
    timeModified: iso(r.time_modified),
    syncedAt: iso(r.synced_at),
    deletedAt: iso(r.deleted_at),
    data: r.data,
  };
}
export type ObjectView = ReturnType<typeof objectView>;

export function commandView(c: CommandRow, opts: { detail?: boolean } = {}) {
  const base = {
    id: c.id,
    kind: c.kind,
    rqName: c.rq_name,
    objectType: c.object_type,
    objectId: c.object_id,
    status: c.status,
    priority: c.priority,
    statusCode: c.status_code,
    statusMessage: c.status_message,
    result: c.result,
    attempts: c.attempts,
    actorType: c.actor_type,
    actorId: c.actor_id,
    createdAt: iso(c.created_at),
    updatedAt: iso(c.updated_at),
    startedAt: iso(c.started_at),
    finishedAt: iso(c.finished_at),
  };
  if (!opts.detail) return base;
  return {
    ...base,
    payload: c.payload,
    requestXml: c.request_xml,
    responseXml: c.response_xml,
  };
}
export type CommandView = ReturnType<typeof commandView>;

export function userView(u: AppUserRow, roles: Pick<RoleRow, 'id' | 'name'>[] = []) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    isActive: u.is_active,
    createdAt: iso(u.created_at),
    lastLoginAt: iso(u.last_login_at),
    roles: roles.map((r) => ({ id: r.id, name: r.name })),
  };
}

export function roleView(r: RoleRow, userCount?: number) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    permissions: r.permissions,
    createdAt: iso(r.created_at),
    ...(userCount === undefined ? {} : { userCount }),
  };
}

export function tokenView(t: ApiTokenRow) {
  return {
    id: t.id,
    name: t.name,
    tokenPrefix: t.token_prefix,
    permissions: t.permissions,
    createdBy: t.created_by,
    createdAt: iso(t.created_at),
    lastUsedAt: iso(t.last_used_at),
    expiresAt: iso(t.expires_at),
    revokedAt: iso(t.revoked_at),
  };
}

export function syncStateView(s: SyncStateRow) {
  return {
    type: s.type,
    status: s.status,
    error: s.error,
    rowCount: s.row_count,
    lastModifiedCursor: iso(s.last_modified_cursor),
    lastFullSyncAt: iso(s.last_full_sync_at),
    lastReconcileAt: iso(s.last_reconcile_at),
    lastRunAt: iso(s.last_run_at),
    updatedAt: iso(s.updated_at),
  };
}

export function auditView(a: AuditLogRow) {
  return {
    id: String(a.id),
    at: iso(a.at),
    actorType: a.actor_type,
    actorId: a.actor_id,
    action: a.action,
    objectType: a.object_type,
    objectId: a.object_id,
    commandId: a.command_id,
    ip: a.ip,
    detail: a.detail,
  };
}
