import { sql, type RawBuilder, type SqlBool } from 'kysely';
import type { Db } from './client.js';
import { QueryError, toPrefixTsQuery } from './objects.js';

/**
 * Cross-type search over the read model, used by the spotlight search.
 *
 * One query ranks matches inside each type and returns the top `perType` hits
 * for the selected types, plus a match count for every allowed type so the
 * UI can show type facets with counts even for types that are not selected.
 */
export interface SearchQuery {
  /** Free text, prefix-matched on every word. Optional when a filter is set. */
  q?: string;
  /** Types the caller may read. Nothing outside this list is searched. */
  allowedTypes: readonly string[];
  /** Restrict returned hits to these types (facet counts still cover all allowed types). */
  types?: readonly string[];
  /** Transaction date range (YYYY-MM-DD, inclusive). Excludes objects without a date. */
  dateFrom?: string;
  dateTo?: string;
  /**
   * A customer, vendor, employee or other-name ListID. Matches transactions
   * whose CustomerRef/VendorRef/EntityRef points at it, the entity itself,
   * and, for customers, its jobs and their transactions.
   */
  entityId?: string;
  amountMin?: string;
  amountMax?: string;
  includeInactive?: boolean;
  /** Hits returned per selected type (default 5, max 50). */
  perType?: number;
}

export interface SearchHit {
  type: string;
  qbId: string;
  name: string | null;
  refNumber: string | null;
  txnDate: string | null;
  amount: string | null;
  isActive: boolean | null;
  entityRefId: string | null;
  /** FullName of the customer/vendor/payee a transaction belongs to. */
  entityName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  memo: string | null;
  rank: number;
}

export interface SearchGroup {
  type: string;
  /** Matches of this type (may exceed items.length). */
  total: number;
  /** Top hits; empty for types that matched but were not selected. */
  items: SearchHit[];
}

export interface SearchResult {
  groups: SearchGroup[];
}

export const SEARCH_MAX_PER_TYPE = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUM = /^[+-]?\d+(\.\d+)?$/;

/** The entity itself plus, for a customer, every job beneath it (FullName prefix). */
async function entityScope(db: Db, id: string): Promise<string[]> {
  const rows = await sql<{ qb_id: string }>`
    select c.qb_id from qb_object p
    join qb_object c on c.type = p.type
      and (c.qb_id = p.qb_id or c.name like replace(replace(replace(p.name, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || ':%')
    where p.qb_id = ${id} and p.deleted_at is null and c.deleted_at is null`.execute(db);
  const ids = rows.rows.map((r) => r.qb_id);
  return ids.length ? ids : [id];
}

export async function searchObjects(db: Db, query: SearchQuery): Promise<SearchResult> {
  const allowed = [...new Set(query.allowedTypes)];
  if (allowed.length === 0) return { groups: [] };

  const perType = Math.min(Math.max(query.perType ?? 5, 1), SEARCH_MAX_PER_TYPE);
  const tsq = query.q ? toPrefixTsQuery(query.q) : null;
  const hasFilter = !!(
    query.dateFrom ||
    query.dateTo ||
    query.entityId ||
    query.amountMin ||
    query.amountMax
  );
  if (!tsq && !hasFilter) throw new QueryError('Enter search text or at least one filter');

  for (const [k, v] of [
    ['dateFrom', query.dateFrom],
    ['dateTo', query.dateTo],
  ] as const) {
    if (v && !DATE.test(v)) throw new QueryError(`${k} expects YYYY-MM-DD`);
  }
  for (const [k, v] of [
    ['amountMin', query.amountMin],
    ['amountMax', query.amountMax],
  ] as const) {
    if (v && !NUM.test(v)) throw new QueryError(`${k} expects a number`);
  }

  const where: RawBuilder<SqlBool>[] = [
    sql`deleted_at is null`,
    sql`type = any(${allowed}::text[])`,
  ];
  if (tsq) where.push(sql`search @@ to_tsquery('simple', ${tsq})`);
  if (!query.includeInactive) where.push(sql`(is_active is null or is_active)`);
  if (query.dateFrom) where.push(sql`txn_date >= ${query.dateFrom}::date`);
  if (query.dateTo) where.push(sql`txn_date <= ${query.dateTo}::date`);
  if (query.amountMin) where.push(sql`amount >= ${query.amountMin}::numeric`);
  if (query.amountMax) where.push(sql`amount <= ${query.amountMax}::numeric`);
  if (query.entityId) {
    const ids = await entityScope(db, query.entityId);
    where.push(sql`(entity_ref_id = any(${ids}::text[]) or qb_id = any(${ids}::text[]))`);
  }

  const selected = query.types?.filter((t) => allowed.includes(t)) ?? [];
  const rank = tsq ? sql`ts_rank(search, to_tsquery('simple', ${tsq}))` : sql`0`;
  // Types not selected still return their best row so their count reaches the facets.
  const limit = selected.length
    ? sql`case when type = any(${selected}::text[]) then ${perType} else 1 end`
    : sql`${perType}`;

  const res = await sql<{
    type: string;
    qb_id: string;
    name: string | null;
    ref_number: string | null;
    txn_date: string | null;
    amount: string | null;
    is_active: boolean | null;
    entity_ref_id: string | null;
    entity_name: string | null;
    company_name: string | null;
    email: string | null;
    phone: string | null;
    memo: string | null;
    rank: number;
    rn: string;
    total: string;
  }>`
    with hits as (
      select type, qb_id, name, ref_number, to_char(txn_date, 'YYYY-MM-DD') as txn_date,
        amount::text as amount, is_active, entity_ref_id,
        coalesce(data #>> '{CustomerRef,FullName}', data #>> '{VendorRef,FullName}',
          data #>> '{EntityRef,FullName}', data #>> '{PayeeEntityRef,FullName}') as entity_name,
        data ->> 'CompanyName' as company_name, data ->> 'Email' as email,
        data ->> 'Phone' as phone, data ->> 'Memo' as memo,
        ${rank}::float8 as rank
      from qb_object
      where ${sql.join(where, sql` and `)}
    ), numbered as (
      select hits.*,
        row_number() over (partition by type order by rank desc, txn_date desc nulls last, name, qb_id) as rn,
        count(*) over (partition by type) as total
      from hits
    )
    select * from numbered where rn <= ${limit}
    order by type, rn`.execute(db);

  const groups = new Map<string, SearchGroup & { best: number }>();
  for (const r of res.rows) {
    let g = groups.get(r.type);
    if (!g) {
      g = { type: r.type, total: Number(r.total), items: [], best: r.rank };
      groups.set(r.type, g);
    }
    if (selected.length && !selected.includes(r.type)) continue;
    g.items.push({
      type: r.type,
      qbId: r.qb_id,
      name: r.name,
      refNumber: r.ref_number,
      txnDate: r.txn_date,
      amount: r.amount,
      isActive: r.is_active,
      entityRefId: r.entity_ref_id,
      entityName: r.entity_name,
      companyName: r.company_name,
      email: r.email,
      phone: r.phone,
      memo: r.memo,
      rank: r.rank,
    });
  }

  // Best-ranked group first; ties (or no text) by match count, then name.
  const sorted = [...groups.values()].sort(
    (a, b) => b.best - a.best || b.total - a.total || a.type.localeCompare(b.type),
  );
  return { groups: sorted.map(({ best: _best, ...g }) => g) };
}
