/**
 * Shapes the web app works with. They mirror the @qbv/qbxml catalog (served by
 * GET /api/meta) and the read-model / command rows served by the API, after
 * normalisation in ./normalize.ts (which accepts snake_case or camelCase).
 */

export interface AttributeDef {
  name: string;
  type: string;
  required: boolean;
  maxLength?: number;
  enum?: string[];
  default?: string;
}

export interface FieldDef {
  name: string;
  kind: 'simple' | 'complex';
  /** Base XSD type (STRTYPE, AMTTYPE, ...) for simple fields; the ObjectDef name for complex ones. */
  type: string;
  minOccurs: number;
  maxOccurs: number | 'unbounded';
  maxLength?: number;
  enum?: string[];
  minInclusive?: number;
  maxInclusive?: number;
  default?: string;
  choiceGroup?: string;
  choiceBranch?: number;
  choicePath?: string[];
  children?: string;
  attributes?: AttributeDef[];
}

export interface ObjectDef {
  name: string;
  fields: FieldDef[];
  attributes?: AttributeDef[];
}

export type RequestOp = 'Add' | 'Mod' | 'Query' | 'Del' | 'Void' | 'Other';

export interface RequestDef {
  name: string;
  response?: string;
  op: RequestOp;
  entity?: string;
  bodyElement?: string;
  retElement?: string;
  retElements?: string[];
  supportsIterator?: boolean;
  filters?: string[];
}

export interface EntityDef {
  name: string;
  category: 'list' | 'txn' | 'other';
  idField: 'ListID' | 'TxnID' | null;
  ops: { add?: string; mod?: string; query?: string; del?: string; void?: string };
  retElement: string;
  supportsModifiedFilter?: boolean;
  unionQuery?: string;
  delType?: string;
  voidType?: string;
  hasEditSequence?: boolean;
  keyFields?: string[];
  /**
   * False when the entity's query needs filters (BillToPay, ItemAssembliesCanBuild,
   * subscriptions, ...), so sync cannot fill the read model; read it with a live query.
   */
  syncable?: boolean;
  /** Query filters QuickBooks requires for this entity. */
  requiredFilters?: string[];
}

/** Everything the UI needs to render one entity's screens. */
export interface EntityMeta {
  entity: EntityDef;
  /** Every ObjectDef reachable from the entity's Add/Mod/Ret objects. */
  objects: Record<string, ObjectDef>;
  requests: Record<string, RequestDef>;
}

/** One read-model row (qb_object). */
export interface QbObject {
  type: string;
  id: string;
  editSequence: string | null;
  name: string | null;
  refNumber: string | null;
  txnDate: string | null;
  amount: string | null;
  isActive: boolean | null;
  timeCreated: string | null;
  timeModified: string | null;
  deletedAt: string | null;
  /** The full parsed Ret. */
  data: Record<string, unknown>;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type CommandStatus = 'queued' | 'sending' | 'succeeded' | 'failed' | 'conflict' | 'rejected';
export type CommandKind = 'add' | 'mod' | 'del' | 'void' | 'raw' | 'query' | 'report';

export const ACTIVE_STATUSES: readonly CommandStatus[] = ['queued', 'sending'];
export const PROBLEM_STATUSES: readonly CommandStatus[] = ['failed', 'conflict', 'rejected'];
export const TERMINAL_STATUSES: readonly CommandStatus[] = [
  'succeeded',
  'failed',
  'conflict',
  'rejected',
];

export interface Command {
  id: string;
  kind: CommandKind | string;
  status: CommandStatus;
  rqName: string | null;
  objectType: string | null;
  objectId: string | null;
  payload: unknown;
  requestXml: string | null;
  responseXml: string | null;
  statusCode: number | null;
  statusMessage: string | null;
  result: Record<string, unknown> | null;
  priority: number | null;
  attempts: number | null;
  actorType: string | null;
  actorId: string | null;
  createdAt: string | null;
  finishedAt: string | null;
}

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  permissions: string[];
  roles: string[];
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  roles: string[];
  createdAt: string | null;
  lastLoginAt: string | null;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
}

export interface ApiToken {
  id: string;
  name: string;
  tokenPrefix: string | null;
  permissions: string[];
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

export interface SyncState {
  type: string;
  status: string | null;
  error: string | null;
  rowCount: number | null;
  lastModifiedCursor: string | null;
  lastFullSyncAt: string | null;
  lastRunAt: string | null;
}

export interface HealthStatus {
  ok: boolean;
  relayConnected: boolean | null;
  components: Record<string, unknown>;
}

/** qbv:events messages (DESIGN 6.3). */
export type QbvEvent =
  | { type: 'object.changed'; objectType: string; qbId: string; op: string }
  | {
      type: 'command.updated';
      id: string;
      status: CommandStatus;
      objectType?: string | null;
      objectId?: string | null;
      actorId?: string | null;
    }
  | { type: 'sync.progress'; objectType: string; status: string; count: number }
  | { type: 'relay.health'; connected: boolean; error?: string | null };

export type QbvEventType = QbvEvent['type'];
