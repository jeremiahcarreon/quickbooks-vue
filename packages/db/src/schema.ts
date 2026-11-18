import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * jsonb column. pg serialises plain objects automatically; wrap top-level
 * arrays with `jsonb()` (see json.ts) because pg would send them as a
 * Postgres array literal instead.
 */
export type JsonColumn<T = JsonValue> = ColumnType<T, T, T>;
export type NullableJsonColumn<T = JsonValue> = ColumnType<
  T | null,
  T | null | undefined,
  T | null
>;

/** timestamptz: read as Date, written as Date or ISO string. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
export type CreatedAt = ColumnType<Date, Date | string | undefined, Date | string>;

/** `date` columns are kept as `YYYY-MM-DD` strings (type parser installed by createDb). */
export type DateString = ColumnType<string | null, string | null | undefined, string | null>;

/** numeric: read as string to stay exact. */
export type Numeric = ColumnType<
  string | null,
  string | number | null | undefined,
  string | number | null
>;

export interface QbObjectTable {
  type: string;
  qb_id: string;
  edit_sequence: string | null;
  /** FullName/Name for lists; the customer/vendor/payee FullName for transactions. */
  name: string | null;
  ref_number: string | null;
  txn_date: DateString;
  entity_ref_id: string | null;
  amount: Numeric;
  is_active: boolean | null;
  time_created: NullableTimestamp;
  time_modified: NullableTimestamp;
  data: JsonColumn<Record<string, unknown>>;
  synced_at: Timestamp;
  deleted_at: NullableTimestamp;
  /** Generated tsvector; never written. */
  search: ColumnType<string, never, never>;
}

export interface SyncStateTable {
  type: string;
  last_modified_cursor: NullableTimestamp;
  last_full_sync_at: NullableTimestamp;
  last_reconcile_at: NullableTimestamp;
  last_run_at: NullableTimestamp;
  /** Free-form status set by the sync service, e.g. idle | running | ok | error. */
  status: ColumnType<string, string | undefined, string>;
  error: string | null;
  row_count: ColumnType<number, number | undefined, number>;
  updated_at: CreatedAt;
}

export const COMMAND_KINDS = ['add', 'mod', 'del', 'void', 'raw', 'query', 'report'] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export const COMMAND_STATUSES = [
  'queued',
  'sending',
  'succeeded',
  'failed',
  'conflict',
  'rejected',
] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];
export const TERMINAL_COMMAND_STATUSES: readonly CommandStatus[] = [
  'succeeded',
  'failed',
  'conflict',
  'rejected',
];

export const ACTOR_TYPES = ['user', 'token', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface CommandTable {
  id: Generated<string>;
  kind: CommandKind;
  rq_name: string | null;
  object_type: string | null;
  object_id: string | null;
  payload: NullableJsonColumn;
  request_xml: string | null;
  response_xml: string | null;
  status: ColumnType<CommandStatus, CommandStatus | undefined, CommandStatus>;
  priority: ColumnType<number, number | undefined, number>;
  status_code: number | null;
  status_message: string | null;
  result: NullableJsonColumn;
  attempts: ColumnType<number, number | undefined, number>;
  actor_type: ActorType;
  actor_id: string | null;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
}

export interface AppUserTable {
  id: Generated<string>;
  email: string;
  display_name: ColumnType<string, string | undefined, string>;
  password_hash: string | null;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  last_login_at: NullableTimestamp;
}

export interface RoleTable {
  id: Generated<string>;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  permissions: ColumnType<string[], string[] | undefined, string[]>;
  created_at: CreatedAt;
}

export interface UserRoleTable {
  user_id: string;
  role_id: string;
}

export interface SessionTable {
  id: string;
  user_id: string;
  csrf_token: string | null;
  expires_at: Timestamp;
  ip: string | null;
  user_agent: string | null;
  data: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >;
  created_at: CreatedAt;
}

export interface ApiTokenTable {
  id: Generated<string>;
  name: string;
  /** sha256 hex of the full token; the token itself is never stored. */
  token_hash: string;
  /** First characters of the token, for display. */
  token_prefix: ColumnType<string, string | undefined, string>;
  permissions: ColumnType<string[], string[] | undefined, string[]>;
  created_by: string | null;
  created_at: CreatedAt;
  last_used_at: NullableTimestamp;
  expires_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
}

export interface AuditLogTable {
  /** bigserial, returned by pg as a string. */
  id: Generated<string>;
  at: CreatedAt;
  actor_type: ActorType;
  actor_id: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  command_id: string | null;
  ip: string | null;
  detail: ColumnType<JsonValue, JsonValue | undefined, JsonValue>;
}

export interface ReportCacheTable {
  key: string;
  report: string;
  params: ColumnType<JsonValue, JsonValue | undefined, JsonValue>;
  result: JsonColumn;
  fetched_at: Timestamp;
  expires_at: Timestamp;
}

export interface Database {
  qb_object: QbObjectTable;
  sync_state: SyncStateTable;
  command: CommandTable;
  app_user: AppUserTable;
  role: RoleTable;
  user_role: UserRoleTable;
  session: SessionTable;
  api_token: ApiTokenTable;
  audit_log: AuditLogTable;
  report_cache: ReportCacheTable;
}

export type QbObjectRow = Omit<Selectable<QbObjectTable>, 'search'>;
export type NewQbObject = Insertable<QbObjectTable>;
export type SyncStateRow = Selectable<SyncStateTable>;
export type CommandRow = Selectable<CommandTable>;
export type CommandUpdate = Updateable<CommandTable>;
export type AppUserRow = Selectable<AppUserTable>;
export type RoleRow = Selectable<RoleTable>;
export type SessionRow = Selectable<SessionTable>;
export type ApiTokenRow = Selectable<ApiTokenTable>;
export type AuditLogRow = Selectable<AuditLogTable>;
export type ReportCacheRow = Selectable<ReportCacheTable>;
