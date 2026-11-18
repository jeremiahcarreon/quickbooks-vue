/**
 * Tolerant mappers from API JSON to the shapes in ./types.ts. The API returns
 * database rows (snake_case) in some places and camelCase in others; every
 * mapper accepts both so the UI does not break on either.
 */
import type {
  AdminUser,
  ApiToken,
  Command,
  CommandStatus,
  CurrentUser,
  EntityDef,
  EntityMeta,
  FieldDef,
  HealthStatus,
  ObjectDef,
  Page,
  QbObject,
  QbvEvent,
  RequestDef,
  Role,
  SyncState,
} from './types';

type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** First defined value among the given keys. */
function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}
const str = (v: unknown): string | null =>
  v === undefined || v === null ? null : typeof v === 'string' ? v : String(v);
const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean | null =>
  v === undefined || v === null ? null : v === true || v === 'true' || v === 1;
const strArr = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => (isObj(x) ? (str(pick(x, 'name', 'id')) ?? '') : String(x))).filter(Boolean)
    : [];

/** Unwrap `{ data: x }`, `{ items: x }` or a named key, as lists and singles. */
export function unwrapList(v: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObj(v)) {
    for (const k of [...keys, 'items', 'data', 'results', 'rows']) {
      const x = v[k];
      if (Array.isArray(x)) return x;
      if (isObj(x) && k !== 'data') return Object.values(x);
    }
  }
  return [];
}

function unwrapOne(v: unknown, ...keys: string[]): Obj {
  if (!isObj(v)) return {};
  for (const k of keys) if (isObj(v[k])) return v[k] as Obj;
  return v;
}

// ---------------------------------------------------------------- meta

function toFieldDef(f: Obj): FieldDef {
  return { ...(f as unknown as FieldDef), minOccurs: num(f.minOccurs) ?? 0 };
}

export function toObjectDef(v: unknown, name?: string): ObjectDef | null {
  if (!isObj(v) || !Array.isArray(v.fields)) return null;
  return {
    name: str(v.name) ?? name ?? '',
    fields: (v.fields as Obj[]).map(toFieldDef),
    ...(Array.isArray(v.attributes) ? { attributes: v.attributes as ObjectDef['attributes'] } : {}),
  };
}

export function toObjectMap(v: unknown): Record<string, ObjectDef> {
  const out: Record<string, ObjectDef> = {};
  if (Array.isArray(v)) {
    for (const o of v) {
      const d = toObjectDef(o);
      if (d?.name) out[d.name] = d;
    }
  } else if (isObj(v)) {
    for (const [k, o] of Object.entries(v)) {
      const d = toObjectDef(o, k);
      if (d) out[d.name || k] = d;
    }
  }
  return out;
}

export function toEntityDef(v: unknown): EntityDef | null {
  if (!isObj(v)) return null;
  const name = str(v.name);
  if (!name) return null;
  const ops = isObj(v.ops) ? (v.ops as EntityDef['ops']) : {};
  return {
    ...(v as unknown as EntityDef),
    name,
    category: (str(v.category) as EntityDef['category']) ?? 'other',
    idField: (str(v.idField) as EntityDef['idField']) ?? null,
    ops,
    retElement: str(v.retElement) ?? `${name}Ret`,
  };
}

export function toEntityList(v: unknown): EntityDef[] {
  return unwrapList(v, 'entities')
    .map(toEntityDef)
    .filter((e): e is EntityDef => e !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * GET /meta/entities/:type. Accepts `{ entity, objects, requests }`, an
 * EntityDef with `objects` alongside, or objects keyed as `add`/`mod`/`ret`.
 */
export function toEntityMeta(v: unknown): EntityMeta | null {
  if (!isObj(v)) return null;
  const entity = toEntityDef(isObj(v.entity) ? v.entity : v);
  if (!entity) return null;
  const objects = toObjectMap(v.objects);
  for (const k of ['add', 'mod', 'ret', 'addObject', 'modObject', 'retObject']) {
    const d = toObjectDef(v[k]);
    if (d?.name) objects[d.name] = d;
  }
  const requests: Record<string, RequestDef> = {};
  const rq = v.requests;
  const list = Array.isArray(rq) ? rq : isObj(rq) ? Object.values(rq) : [];
  for (const r of list) {
    if (isObj(r) && typeof r.name === 'string') requests[r.name] = r as unknown as RequestDef;
  }
  return { entity, objects, requests };
}

// ---------------------------------------------------------------- objects

export function toQbObject(v: unknown, type?: string): QbObject {
  const o = isObj(v) ? v : {};
  const data = isObj(o.data) ? o.data : o;
  const id = str(pick(o, 'qb_id', 'qbId', 'id')) ?? str(pick(data, 'ListID', 'TxnID')) ?? '';
  return {
    type: str(o.type) ?? type ?? '',
    id,
    editSequence: str(pick(o, 'edit_sequence', 'editSequence')) ?? str(data.EditSequence),
    name: str(o.name) ?? str(pick(data, 'FullName', 'Name')),
    refNumber: str(pick(o, 'ref_number', 'refNumber')) ?? str(data.RefNumber),
    txnDate: str(pick(o, 'txn_date', 'txnDate')) ?? str(data.TxnDate),
    amount: str(o.amount),
    isActive: bool(pick(o, 'is_active', 'isActive')),
    timeCreated: str(pick(o, 'time_created', 'timeCreated')) ?? str(data.TimeCreated),
    timeModified: str(pick(o, 'time_modified', 'timeModified')) ?? str(data.TimeModified),
    deletedAt: str(pick(o, 'deleted_at', 'deletedAt')),
    data,
  };
}

export function toPage<T>(v: unknown, map: (x: unknown) => T): Page<T> {
  const items = unwrapList(v).map(map);
  const o = isObj(v) ? v : {};
  const meta = isObj(o.meta) ? o.meta : isObj(o.pagination) ? o.pagination : o;
  return {
    items,
    total: num(pick(meta, 'total', 'totalCount', 'count')) ?? items.length,
    page: num(meta.page) ?? 1,
    pageSize: num(pick(meta, 'pageSize', 'page_size', 'limit')) ?? items.length,
  };
}

// ---------------------------------------------------------------- commands

const STATUSES: CommandStatus[] = [
  'queued',
  'sending',
  'succeeded',
  'failed',
  'conflict',
  'rejected',
];

export function toStatus(v: unknown): CommandStatus {
  const s = str(v);
  return s && (STATUSES as string[]).includes(s) ? (s as CommandStatus) : 'queued';
}

export function toCommand(v: unknown): Command {
  const o = unwrapOne(v, 'command');
  return {
    id: str(pick(o, 'id', 'commandId', 'command_id')) ?? '',
    kind: str(o.kind) ?? 'raw',
    status: toStatus(o.status),
    rqName: str(pick(o, 'rq_name', 'rqName')),
    objectType: str(pick(o, 'object_type', 'objectType')),
    objectId: str(pick(o, 'object_id', 'objectId')),
    payload: o.payload ?? null,
    requestXml: str(pick(o, 'request_xml', 'requestXml')),
    responseXml: str(pick(o, 'response_xml', 'responseXml')),
    statusCode: num(pick(o, 'status_code', 'statusCode')),
    statusMessage: str(pick(o, 'status_message', 'statusMessage')),
    result: isObj(o.result) ? o.result : null,
    priority: num(o.priority),
    attempts: num(o.attempts),
    actorType: str(pick(o, 'actor_type', 'actorType')),
    actorId: str(pick(o, 'actor_id', 'actorId')),
    createdAt: str(pick(o, 'created_at', 'createdAt')),
    finishedAt: str(pick(o, 'finished_at', 'finishedAt')),
  };
}

/** `202 { commandId }` (or a full command) from a write endpoint. */
export function toCommandRef(v: unknown): { id: string; status: CommandStatus; command?: Command } {
  const o = unwrapOne(v, 'command');
  const id = str(pick(o, 'commandId', 'command_id', 'id')) ?? '';
  return { id, status: toStatus(o.status), ...(o.kind ? { command: toCommand(o) } : {}) };
}

// ---------------------------------------------------------------- auth/admin

export function toCurrentUser(v: unknown): CurrentUser | null {
  // POST /auth/login answers `{ user }`, GET /auth/me answers `{ principal }`.
  const o = unwrapOne(v, 'user', 'principal');
  if (o.type === 'token') return null;
  const id = str(o.id);
  if (!id) return null;
  const outer = isObj(v) ? v : {};
  return {
    id,
    email: str(o.email) ?? '',
    displayName: str(pick(o, 'displayName', 'display_name')) ?? str(o.email) ?? '',
    permissions: strArr(pick(o, 'permissions') ?? outer.permissions),
    roles: strArr(pick(o, 'roles') ?? outer.roles),
  };
}

export function csrfFrom(v: unknown): string | null {
  if (!isObj(v)) return null;
  return str(pick(v, 'csrfToken', 'csrf_token', 'csrf'));
}

export function toAdminUser(v: unknown): AdminUser {
  const o = unwrapOne(v, 'user');
  return {
    id: str(o.id) ?? '',
    email: str(o.email) ?? '',
    displayName: str(pick(o, 'displayName', 'display_name')) ?? '',
    isActive: bool(pick(o, 'isActive', 'is_active')) ?? true,
    roles: strArr(o.roles),
    createdAt: str(pick(o, 'createdAt', 'created_at')),
    lastLoginAt: str(pick(o, 'lastLoginAt', 'last_login_at')),
  };
}

export function toRole(v: unknown): Role {
  const o = unwrapOne(v, 'role');
  return {
    id: str(o.id) ?? str(o.name) ?? '',
    name: str(o.name) ?? '',
    description: str(o.description) ?? '',
    permissions: strArr(o.permissions),
  };
}

export function toApiToken(v: unknown): ApiToken {
  const o = unwrapOne(v, 'apiToken');
  return {
    id: str(o.id) ?? '',
    name: str(o.name) ?? '',
    tokenPrefix: str(pick(o, 'tokenPrefix', 'token_prefix', 'prefix')),
    permissions: strArr(o.permissions),
    createdAt: str(pick(o, 'createdAt', 'created_at')),
    lastUsedAt: str(pick(o, 'lastUsedAt', 'last_used_at')),
    revokedAt: str(pick(o, 'revokedAt', 'revoked_at')),
    expiresAt: str(pick(o, 'expiresAt', 'expires_at')),
  };
}

export function toSyncState(v: unknown): SyncState {
  const o = isObj(v) ? v : {};
  return {
    type: str(pick(o, 'type', 'objectType')) ?? '',
    status: str(o.status),
    error: str(o.error),
    rowCount: num(pick(o, 'rowCount', 'row_count', 'count')),
    lastModifiedCursor: str(pick(o, 'lastModifiedCursor', 'last_modified_cursor')),
    lastFullSyncAt: str(pick(o, 'lastFullSyncAt', 'last_full_sync_at')),
    lastRunAt: str(pick(o, 'lastRunAt', 'last_run_at')),
  };
}

/** GET /health: accepts `{ relay: { connected } }`, `{ relay: 'ok' }`, `{ checks: {...} }`. */
export function toHealth(v: unknown): HealthStatus {
  const o = isObj(v) ? v : {};
  const comps = isObj(o.checks) ? o.checks : isObj(o.components) ? o.components : o;
  const relay = comps.relay ?? o.relay;
  let relayConnected: boolean | null = null;
  if (typeof relay === 'boolean') relayConnected = relay;
  else if (typeof relay === 'string') relayConnected = /^(ok|up|connected|healthy)$/i.test(relay);
  else if (isObj(relay)) {
    const c = pick(relay, 'connected', 'ok', 'healthy');
    if (typeof c === 'boolean') relayConnected = c;
    else if (typeof relay.status === 'string')
      relayConnected = /^(ok|up|connected|healthy)$/i.test(relay.status);
  }
  const status = str(o.status);
  const ok = typeof o.ok === 'boolean' ? o.ok : status ? /^(ok|up|healthy)$/i.test(status) : true;
  return { ok, relayConnected, components: comps };
}

/** Parse an SSE `data:` payload. `eventName` is used when the payload has no `type`. */
export function toEvent(raw: string, eventName?: string): QbvEvent | null {
  let e: unknown;
  try {
    e = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(e)) return null;
  const type = str(e.type) ?? (eventName && eventName !== 'message' ? eventName : null);
  if (!type) return null;
  const o: Obj = { ...e, type };
  switch (type) {
    case 'object.changed':
      return typeof o.objectType === 'string' && typeof o.qbId === 'string'
        ? (o as unknown as QbvEvent)
        : null;
    case 'command.updated':
      return typeof o.id === 'string' && typeof o.status === 'string'
        ? ({ ...o, status: toStatus(o.status) } as unknown as QbvEvent)
        : null;
    case 'sync.progress':
      return typeof o.objectType === 'string'
        ? ({ ...o, count: num(o.count) ?? 0, status: str(o.status) ?? '' } as unknown as QbvEvent)
        : null;
    case 'relay.health':
      return typeof o.connected === 'boolean' ? (o as unknown as QbvEvent) : null;
    default:
      return null;
  }
}
