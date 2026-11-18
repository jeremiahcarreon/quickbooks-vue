import { buildRequest, getObject, type FieldDef } from '@qbv/qbxml';
import type { SyncUnit } from './plan.js';

/**
 * Every query sync sends is built here, through @qbv/qbxml `buildRequest`,
 * which orders the elements by the schema and validates the document against
 * the XSD (it throws QbxmlValidationError otherwise). Nothing in this module
 * concatenates XML.
 */

export interface QueryBuildOptions {
  /** qbXML version header (QBXML_VERSION). */
  version?: string;
  /** MaxReturned for paged (iterator) queries. */
  pageSize?: number;
  /** Ask for public custom fields (OwnerID 0) where the query supports it. */
  includeCustomFields?: boolean;
  /** Ask for linked transactions (IncludeLinkedTxns) where supported. */
  includeLinkedTxns?: boolean;
  requestID?: string;
}

export interface BuiltQuery {
  rq: string;
  xml: string;
  /** Rq body passed to buildRequest (stored as the command payload). */
  body: Record<string, unknown>;
  iterator?: 'Start' | 'Continue';
  iteratorID?: string;
  /** Wanted elements left out because the schema's choice groups exclude them. */
  dropped: string[];
}

export const DEFAULT_PAGE_SIZE = 500;
/** Ids per fetch-by-id query during reconcile. */
export const ID_BATCH_SIZE = 100;
/** QuickBooks keeps deleted-object records for roughly 90 days. */
export const DELETED_HISTORY_DAYS = 89;

function choicePath(f: FieldDef): string[] {
  if (f.choicePath && f.choicePath.length > 0) return f.choicePath;
  return f.choiceGroup !== undefined ? [`${f.choiceGroup}:${f.choiceBranch ?? 0}`] : [];
}

/**
 * Keep the wanted elements that exist in the request and fit together under
 * the schema's xsd:choice groups, in priority order: an element whose choice
 * branch conflicts with one already picked is dropped. For example
 * `CustomerQueryRq` puts ListID, FullName and the filter sequence (MaxReturned,
 * ActiveStatus, FromModifiedDate, ...) in three branches of one choice, so
 * asking for ListID first drops MaxReturned and ActiveStatus.
 */
export function selectFields(
  rq: string,
  wanted: ReadonlyArray<readonly [string, unknown]>,
): { body: Record<string, unknown>; dropped: string[] } {
  const obj = getObject(rq);
  const byName = new Map(obj.fields.map((f) => [f.name, f]));
  const chosen = new Map<string, string>(); // choice group -> branch
  const body: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [name, value] of wanted) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const f = byName.get(name);
    if (!f) {
      dropped.push(name);
      continue;
    }
    const path = choicePath(f).map((p) => {
      const i = p.lastIndexOf(':');
      return [p.slice(0, i), p.slice(i + 1)] as const;
    });
    if (path.some(([g, b]) => chosen.has(g) && chosen.get(g) !== b)) {
      dropped.push(name);
      continue;
    }
    for (const [g, b] of path) chosen.set(g, b);
    body[name] = value;
  }
  return { body, dropped };
}

function hasField(rq: string, name: string): boolean {
  return getObject(rq).fields.some((f) => f.name === name);
}

/** Elements that make a query return complete objects: lines, all statuses, custom fields. */
function completenessFields(
  rq: string,
  opts: QueryBuildOptions,
): Array<readonly [string, unknown]> {
  const out: Array<readonly [string, unknown]> = [];
  // Lists default to ActiveOnly and ToDos to NotDoneOnly; the read model wants everything.
  out.push(['ActiveStatus', 'All']);
  out.push(['DoneStatus', 'All']);
  // Transactions omit their lines unless asked.
  if (hasField(rq, 'IncludeLineItems')) out.push(['IncludeLineItems', true]);
  if (hasField(rq, 'IncludeComponentLineItems')) out.push(['IncludeComponentLineItems', true]);
  if (opts.includeLinkedTxns && hasField(rq, 'IncludeLinkedTxns')) {
    out.push(['IncludeLinkedTxns', true]);
  }
  if (opts.includeCustomFields !== false && hasField(rq, 'OwnerID')) out.push(['OwnerID', '0']);
  return out;
}

function modifiedFilterField(unit: SyncUnit, from: Date): readonly [string, unknown] {
  return unit.modifiedFilter === 'ModifiedDateRangeFilter'
    ? ['ModifiedDateRangeFilter', { FromModifiedDate: from }]
    : ['FromModifiedDate', from];
}

function build(
  rq: string,
  wanted: Array<readonly [string, unknown]>,
  opts: QueryBuildOptions,
  iterator?: { iterator: 'Start' | 'Continue'; iteratorID?: string },
): BuiltQuery {
  const { body, dropped } = selectFields(rq, wanted);
  const xml = buildRequest(rq, body, {
    version: opts.version,
    requestID: opts.requestID ?? '1',
    ...(iterator ?? {}),
  });
  return { rq, xml, body, dropped, ...(iterator ?? {}) };
}

export type PageIterator = { iterator: 'Start' } | { iterator: 'Continue'; iteratorID: string };

/**
 * A page of a load: the full query (since `from` when given) for a unit. With
 * paging, MaxReturned + iterator Start/Continue; the Continue request repeats
 * the same query with the iteratorID QuickBooks returned.
 */
export function buildLoadQuery(
  unit: SyncUnit,
  opts: QueryBuildOptions & { from?: Date; page?: PageIterator } = {},
): BuiltQuery {
  const wanted: Array<readonly [string, unknown]> = [];
  if (unit.paging) wanted.push(['MaxReturned', opts.pageSize ?? DEFAULT_PAGE_SIZE]);
  if (opts.from && unit.modifiedFilter) wanted.push(modifiedFilterField(unit, opts.from));
  wanted.push(...completenessFields(unit.rq, opts));
  const it = unit.paging ? (opts.page ?? { iterator: 'Start' as const }) : undefined;
  return build(unit.rq, wanted, opts, it);
}

/** Initial (full) load, page `page`. Priority 10. */
export function buildInitialQuery(
  unit: SyncUnit,
  opts: QueryBuildOptions & { page?: PageIterator } = {},
): BuiltQuery {
  return buildLoadQuery(unit, { ...opts, from: undefined });
}

/** Incremental load since `from` (cursor minus overlap). Priority 5. */
export function buildIncrementalQuery(
  unit: SyncUnit,
  from: Date,
  opts: QueryBuildOptions & { page?: PageIterator } = {},
): BuiltQuery {
  if (!unit.modifiedFilter) throw new Error(`${unit.key}: ${unit.rq} has no modified-date filter`);
  return buildLoadQuery(unit, { ...opts, from });
}

/**
 * Reconcile: every object, IDs only (IncludeRetElement idField, EditSequence,
 * TimeModified), to find rows missing from or extra in the read model.
 */
export function buildReconcileQuery(
  unit: SyncUnit,
  opts: QueryBuildOptions & { page?: PageIterator } = {},
): BuiltQuery {
  if (!unit.idField || !unit.reconcilable) {
    throw new Error(
      `${unit.key}: ${unit.rq} cannot list ids only; it is re-queried in full instead`,
    );
  }
  const include: string[] = [unit.idField];
  if (unit.hasEditSequence) include.push('EditSequence');
  if (unit.hasTimeModified) include.push('TimeModified');
  const wanted: Array<readonly [string, unknown]> = [];
  if (unit.paging) wanted.push(['MaxReturned', opts.pageSize ?? DEFAULT_PAGE_SIZE]);
  wanted.push(['ActiveStatus', 'All'], ['DoneStatus', 'All'], ['IncludeRetElement', include]);
  const it = unit.paging ? (opts.page ?? { iterator: 'Start' as const }) : undefined;
  return build(unit.rq, wanted, opts, it);
}

/** Fetch complete objects by id (ListID/TxnID list). Used by reconcile to repair rows. */
export function buildFetchByIdsQuery(
  unit: SyncUnit,
  ids: readonly string[],
  opts: QueryBuildOptions = {},
): BuiltQuery {
  if (!unit.idField || !unit.reconcilable) {
    throw new Error(`${unit.key}: ${unit.rq} cannot filter by ${unit.idField ?? 'id'}`);
  }
  if (ids.length === 0) throw new Error('buildFetchByIdsQuery: no ids');
  const wanted: Array<readonly [string, unknown]> = [[unit.idField, [...ids]]];
  wanted.push(...completenessFields(unit.rq, opts));
  return build(unit.rq, wanted, opts);
}

/**
 * ListDeletedQueryRq / TxnDeletedQueryRq for the given ListDelType/TxnDelType
 * values, deleted since `from` (omitted when older than QuickBooks keeps).
 */
export function buildDeletedQuery(
  kind: 'list' | 'txn',
  delTypes: readonly string[],
  opts: QueryBuildOptions & { from?: Date; now?: Date } = {},
): BuiltQuery {
  if (delTypes.length === 0) throw new Error('buildDeletedQuery: no delete types');
  const rq = kind === 'list' ? 'ListDeletedQueryRq' : 'TxnDeletedQueryRq';
  const typeField = kind === 'list' ? 'ListDelType' : 'TxnDelType';
  const now = opts.now ?? new Date();
  const oldest = new Date(now.getTime() - DELETED_HISTORY_DAYS * 86_400_000);
  const from = opts.from && opts.from > oldest ? opts.from : undefined;
  const wanted: Array<readonly [string, unknown]> = [[typeField, [...delTypes]]];
  if (from) wanted.push(['DeletedDateRangeFilter', { FromDeletedDate: from }]);
  return build(rq, wanted, opts);
}

/** The delete-type enum values the deleted query accepts (from the schema). */
export function deletedQueryTypes(kind: 'list' | 'txn'): string[] {
  const rq = kind === 'list' ? 'ListDeletedQueryRq' : 'TxnDeletedQueryRq';
  const f = getObject(rq).fields.find(
    (x) => x.name === (kind === 'list' ? 'ListDelType' : 'TxnDelType'),
  );
  return f?.enum ?? [];
}
