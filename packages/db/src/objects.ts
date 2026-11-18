import { sql, type Expression, type SqlBool, type ExpressionBuilder } from 'kysely';
import type { Db } from './client.js';
import { jsonb } from './json.js';
import type { Database, NewQbObject, QbObjectRow } from './schema.js';
import { toRow, type EntityLike, type ExtractOverrides, type Ret } from './to-row.js';

const UPSERT_CHUNK = 500;

export interface UpsertOptions {
  syncedAt?: Date;
  overrides?: ExtractOverrides;
}

/**
 * Insert or update Rets in the read model. Accepts the catalog EntityDef (or
 * just its name; the ID is then read from ListID/TxnID). A row is only
 * overwritten by a Ret that is at least as new (TimeModified), so a slow sync
 * page cannot clobber a newer write-through from the worker. Re-upserting a
 * deleted object clears deleted_at. Returns the number of rows written.
 */
export async function upsertObjects(
  db: Db,
  entity: EntityLike | string,
  rets: readonly Ret[],
  opts: UpsertOptions = {},
): Promise<number> {
  if (rets.length === 0) return 0;
  const def: EntityLike = typeof entity === 'string' ? { name: entity } : entity;
  const syncedAt = opts.syncedAt ?? new Date();

  // Later Rets for the same id win; Postgres rejects duplicate keys in one upsert.
  const byId = new Map<string, NewQbObject>();
  for (const ret of rets) {
    const row = toRow(def, ret, { syncedAt, overrides: opts.overrides });
    byId.set(row.qb_id, row);
  }
  const rows = [...byId.values()];

  let written = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK).map((r) => ({ ...r, data: jsonb(r.data) }));
    const res = await db
      .insertInto('qb_object')
      .values(chunk)
      .onConflict((oc) =>
        oc
          .columns(['type', 'qb_id'])
          .doUpdateSet((eb) => ({
            edit_sequence: eb.ref('excluded.edit_sequence'),
            name: eb.ref('excluded.name'),
            ref_number: eb.ref('excluded.ref_number'),
            txn_date: eb.ref('excluded.txn_date'),
            entity_ref_id: eb.ref('excluded.entity_ref_id'),
            amount: eb.ref('excluded.amount'),
            is_active: eb.ref('excluded.is_active'),
            time_created: eb.ref('excluded.time_created'),
            time_modified: eb.ref('excluded.time_modified'),
            data: eb.ref('excluded.data'),
            synced_at: eb.ref('excluded.synced_at'),
            deleted_at: null,
          }))
          .where((eb) =>
            eb.or([
              eb('qb_object.time_modified', 'is', null),
              eb('excluded.time_modified', 'is', null),
              eb('excluded.time_modified', '>=', eb.ref('qb_object.time_modified')),
              eb('qb_object.deleted_at', 'is not', null),
            ]),
          ),
      )
      .executeTakeFirst();
    written += Number(res.numInsertedOrUpdatedRows ?? 0);
  }
  return written;
}

/** Soft-delete objects (Del, ListDeleted/TxnDeleted). Returns rows changed. */
export async function markDeleted(
  db: Db,
  type: string,
  qbIds: readonly string[],
  at: Date = new Date(),
): Promise<number> {
  if (qbIds.length === 0) return 0;
  const res = await db
    .updateTable('qb_object')
    .set({ deleted_at: at })
    .where('type', '=', type)
    .where('qb_id', 'in', [...qbIds])
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

/**
 * Reconcile: soft-delete every live object of `type` whose id is not in
 * `presentIds` (the full ID list just fetched from QuickBooks).
 */
export async function markMissingDeleted(
  db: Db,
  type: string,
  presentIds: readonly string[],
  at: Date = new Date(),
): Promise<number> {
  const res = await db
    .updateTable('qb_object')
    .set({ deleted_at: at })
    .where('type', '=', type)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`qb_id <> all(${[...presentIds]}::text[])`)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

/** Hard delete (rarely needed: tests, full rebuild of one type). */
export async function purgeObjects(db: Db, type: string): Promise<number> {
  const res = await db.deleteFrom('qb_object').where('type', '=', type).executeTakeFirst();
  return Number(res.numDeletedRows);
}

const ROW_COLUMNS = [
  'type',
  'qb_id',
  'edit_sequence',
  'name',
  'ref_number',
  'txn_date',
  'entity_ref_id',
  'amount',
  'is_active',
  'time_created',
  'time_modified',
  'data',
  'synced_at',
  'deleted_at',
] as const;

export async function getObject(
  db: Db,
  type: string,
  qbId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<QbObjectRow | undefined> {
  let q = db
    .selectFrom('qb_object')
    .select(ROW_COLUMNS)
    .where('type', '=', type)
    .where('qb_id', '=', qbId);
  if (!opts.includeDeleted) q = q.where('deleted_at', 'is', null);
  return q.executeTakeFirst();
}

export async function getObjects(
  db: Db,
  type: string,
  qbIds: readonly string[],
): Promise<QbObjectRow[]> {
  if (qbIds.length === 0) return [];
  return db
    .selectFrom('qb_object')
    .select(ROW_COLUMNS)
    .where('type', '=', type)
    .where('qb_id', 'in', [...qbIds])
    .execute();
}

/** Counts of live objects per type. */
export async function countObjectsByType(db: Db): Promise<Record<string, number>> {
  const rows = await db
    .selectFrom('qb_object')
    .select(['type', (eb) => eb.fn.countAll<string>().as('n')])
    .where('deleted_at', 'is', null)
    .groupBy('type')
    .execute();
  return Object.fromEntries(rows.map((r) => [r.type, Number(r.n)]));
}

// ---------------------------------------------------------------------------
// Querying

/** Real columns that can be filtered and sorted directly. */
export const OBJECT_COLUMNS = {
  qb_id: 'text',
  edit_sequence: 'text',
  name: 'text',
  ref_number: 'text',
  txn_date: 'date',
  entity_ref_id: 'text',
  amount: 'numeric',
  is_active: 'boolean',
  time_created: 'timestamptz',
  time_modified: 'timestamptz',
  synced_at: 'timestamptz',
  deleted_at: 'timestamptz',
} as const;
export type ObjectColumn = keyof typeof OBJECT_COLUMNS;

/** qbXML element names that map onto a column. */
export const FIELD_ALIASES: Record<string, ObjectColumn> = {
  ListID: 'qb_id',
  TxnID: 'qb_id',
  EditSequence: 'edit_sequence',
  FullName: 'name',
  Name: 'name',
  RefNumber: 'ref_number',
  TxnDate: 'txn_date',
  IsActive: 'is_active',
  TimeCreated: 'time_created',
  TimeModified: 'time_modified',
};

export const FILTER_OPS = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'like',
  'in',
  'isnull',
  'notnull',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface ObjectFilter {
  /** A column (`txn_date`), a qbXML alias (`TxnDate`) or a data path (`CustomerRef.ListID`). */
  field: string;
  op: FilterOp;
  value?: string | number | boolean | (string | number)[] | null;
}

export interface SortSpec {
  field: string;
  dir: 'asc' | 'desc';
}

export interface ObjectQuery {
  type: string;
  /** Full-text search (prefix match on every word). */
  q?: string;
  filters?: ObjectFilter[];
  /** `name,-txn_date` or structured. Default: name, then qb_id. */
  sort?: string | SortSpec[];
  /** 1-based. */
  page?: number;
  pageSize?: number;
  includeInactive?: boolean;
  includeDeleted?: boolean;
}

export interface ObjectPage {
  items: QbObjectRow[];
  total: number;
  page: number;
  pageSize: number;
}

export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 50;

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

type FieldTarget = { kind: 'column'; column: ObjectColumn } | { kind: 'path'; path: string[] };

export function resolveField(field: string): FieldTarget {
  if (field in OBJECT_COLUMNS) return { kind: 'column', column: field as ObjectColumn };
  const alias = FIELD_ALIASES[field];
  if (alias) return { kind: 'column', column: alias };
  const path = field.split('.');
  if (path.length === 0 || path.length > 6 || !path.every((p) => PATH_SEGMENT.test(p))) {
    throw new QueryError(`Invalid field "${field}"`);
  }
  return { kind: 'path', path };
}

/**
 * Parse an API filter value: `gte:2024-01-01`, `in:a,b,c`, `isnull:`,
 * `like:smith`, or a plain value (equality). Prefix `eq:` to compare a value
 * that itself starts with an operator name.
 */
export function parseFilterParam(field: string, raw: string): ObjectFilter {
  const m = /^([a-z]+):(.*)$/s.exec(raw);
  if (m && (FILTER_OPS as readonly string[]).includes(m[1]!)) {
    const op = m[1] as FilterOp;
    const rest = m[2]!;
    if (op === 'in') return { field, op, value: rest.split(',').filter((s) => s.length > 0) };
    if (op === 'isnull' || op === 'notnull') return { field, op };
    return { field, op, value: rest };
  }
  return { field, op: 'eq', value: raw };
}

/** Parse `name,-txn_date` into sort specs. */
export function parseSort(sort: string): SortSpec[] {
  return sort
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      s.startsWith('-')
        ? { field: s.slice(1), dir: 'desc' }
        : { field: s.replace(/^\+/, ''), dir: 'asc' },
    );
}

/** Build a prefix tsquery from free text; only letters/digits survive. */
export function toPrefixTsQuery(q: string): string | null {
  const tokens = q
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .slice(0, 16)
    .map((t) => `${t}:*`)
    .join(' & ');
}

type QbEb = ExpressionBuilder<Database, 'qb_object'>;

function coerceColumnValue(column: ObjectColumn, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const t = OBJECT_COLUMNS[column];
  if (t === 'boolean') {
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    throw new QueryError(`${column} expects true/false`);
  }
  if (t === 'numeric') {
    const s = String(v);
    if (!/^[+-]?\d+(\.\d+)?$/.test(s)) throw new QueryError(`${column} expects a number`);
    return s;
  }
  if (t === 'date') {
    const s = String(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new QueryError(`${column} expects YYYY-MM-DD`);
    return s;
  }
  if (t === 'timestamptz') {
    const s = String(v);
    if (Number.isNaN(Date.parse(s))) throw new QueryError(`${column} expects a timestamp`);
    return s;
  }
  return String(v);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function nest(path: string[], value: unknown): Record<string, unknown> {
  return path.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as Record<
    string,
    unknown
  >;
}

function filterExpr(eb: QbEb, f: ObjectFilter): Expression<SqlBool> {
  const target = resolveField(f.field);
  const ops: Record<Exclude<FilterOp, 'like' | 'in' | 'isnull' | 'notnull'>, string> = {
    eq: '=',
    ne: '<>',
    lt: '<',
    lte: '<=',
    gt: '>',
    gte: '>=',
  };
  if (!(FILTER_OPS as readonly string[]).includes(f.op))
    throw new QueryError(`Unknown operator "${f.op}"`);

  if (target.kind === 'column') {
    const col = sql.ref(`qb_object.${target.column}`);
    switch (f.op) {
      case 'isnull':
        return sql<SqlBool>`${col} is null`;
      case 'notnull':
        return sql<SqlBool>`${col} is not null`;
      case 'like':
        return sql<SqlBool>`${col}::text ilike ${'%' + escapeLike(String(f.value ?? '')) + '%'}`;
      case 'in': {
        const vals = (Array.isArray(f.value) ? f.value : [f.value]).map((v) =>
          coerceColumnValue(target.column, v),
        );
        if (vals.length === 0) return sql<SqlBool>`false`;
        return eb(target.column, 'in', vals as never[]);
      }
      default:
        return sql<SqlBool>`${col} ${sql.raw(ops[f.op])} ${coerceColumnValue(target.column, f.value)}`;
    }
  }

  const text = sql<string>`qb_object.data #>> ${target.path}::text[]`;
  switch (f.op) {
    case 'isnull':
      return sql<SqlBool>`${text} is null`;
    case 'notnull':
      return sql<SqlBool>`${text} is not null`;
    case 'eq':
      // Containment uses the GIN(data jsonb_path_ops) index.
      return sql<SqlBool>`qb_object.data @> ${jsonb(nest(target.path, String(f.value ?? '')))}`;
    case 'like':
      return sql<SqlBool>`${text} ilike ${'%' + escapeLike(String(f.value ?? '')) + '%'}`;
    case 'in': {
      const vals = (Array.isArray(f.value) ? f.value : [f.value]).map((v) => String(v));
      if (vals.length === 0) return sql<SqlBool>`false`;
      return sql<SqlBool>`${text} = any(${vals}::text[])`;
    }
    default:
      return sql<SqlBool>`${text} ${sql.raw(ops[f.op])} ${String(f.value ?? '')}`;
  }
}

/**
 * Page through the read model with filters, sort and full-text search.
 * Inactive list objects are hidden unless includeInactive; deleted objects
 * unless includeDeleted.
 */
export async function queryObjects(db: Db, query: ObjectQuery): Promise<ObjectPage> {
  const pageSize = Math.min(
    Math.max(1, Math.trunc(query.pageSize ?? DEFAULT_PAGE_SIZE)),
    MAX_PAGE_SIZE,
  );
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const tsq = query.q ? toPrefixTsQuery(query.q) : null;
  const sorts = typeof query.sort === 'string' ? parseSort(query.sort) : (query.sort ?? []);

  let base = db.selectFrom('qb_object').where('type', '=', query.type);
  if (!query.includeDeleted) base = base.where('deleted_at', 'is', null);
  if (!query.includeInactive) base = base.where(sql<SqlBool>`is_active is distinct from false`);
  if (tsq) base = base.where(sql<SqlBool>`search @@ to_tsquery('simple', ${tsq})`);
  for (const f of query.filters ?? []) base = base.where((eb) => filterExpr(eb, f));

  let listQ = base.select(ROW_COLUMNS);
  if (sorts.length === 0 && tsq) {
    listQ = listQ.orderBy(sql`ts_rank(search, to_tsquery('simple', ${tsq}))`, 'desc');
  }
  for (const s of sorts.length ? sorts : tsq ? [] : [{ field: 'name', dir: 'asc' as const }]) {
    const target = resolveField(s.field);
    const dir = s.dir === 'desc' ? sql.raw('desc nulls last') : sql.raw('asc nulls last');
    listQ =
      target.kind === 'column'
        ? listQ.orderBy(sql`${sql.ref(`qb_object.${target.column}`)} ${dir}`)
        : listQ.orderBy(sql`qb_object.data #>> ${target.path}::text[] ${dir}`);
  }
  listQ = listQ.orderBy('qb_id', 'asc');

  const [items, count] = await Promise.all([
    listQ
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute(),
    base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
  ]);
  return { items, total: Number(count.n), page, pageSize };
}
