import { sql } from 'kysely';
import type { Db } from '@qbv/db';
import { daysBetween } from '../dates.js';
import type { ParamDef, ReportColumn, ReportParams } from '../types.js';
import {
  asOfParam,
  Dec,
  dt,
  groupBy,
  nameFilter,
  nameFilterParam,
  notPending,
  num,
  ReportBuilder,
  rowsOf,
  txt,
  type SqlReportDefinition,
} from './common.js';

export type Side = 'ar' | 'ap';

export interface OpenItem {
  type: string;
  qb_id: string;
  ref_number: string | null;
  txn_date: string | null;
  due_date: string | null;
  name: string | null;
  terms: string | null;
  open: string;
}

/**
 * Open A/R or A/P items as of today's balances: invoices and statement
 * charges (BalanceRemaining), unapplied credit memos and payments (A/R);
 * bills (OpenAmount) and unapplied vendor credits (A/P). Credits are negative.
 */
export async function openItems(
  db: Db,
  side: Side,
  asOf: string,
  params: ReportParams,
  opts: { chargesOnly?: boolean } = {},
): Promise<OpenItem[]> {
  const openExpr =
    side === 'ar'
      ? sql`case type
          when 'Invoice' then ${num('BalanceRemaining')}
          when 'Charge' then ${num('BalanceRemaining')}
          when 'CreditMemo' then -${num('CreditRemaining')}
          when 'ReceivePayment' then -${num('UnusedPayment')}
        end`
      : sql`case type
          when 'Bill' then coalesce(${num('OpenAmount')},
            case when coalesce(data->>'IsPaid', 'false') <> 'true' then ${num('AmountDue')} end)
          when 'VendorCredit' then -${num('OpenAmount')}
        end`;
  const types =
    side === 'ar'
      ? opts.chargesOnly
        ? ['Invoice', 'Charge']
        : ['Invoice', 'Charge', 'CreditMemo', 'ReceivePayment']
      : opts.chargesOnly
        ? ['Bill']
        : ['Bill', 'VendorCredit'];
  return rowsOf(
    db,
    sql<OpenItem>`
      select * from (
        select type, qb_id, ref_number, txn_date,
          case when type = 'ReceivePayment' then txn_date else coalesce(${dt('DueDate')}, txn_date) end as due_date,
          name, ${txt('TermsRef.FullName')} as terms,
          (${openExpr})::text as open
        from qb_object
        where deleted_at is null
          and type in (${sql.join(types)})
          and (txn_date is null or txn_date <= ${asOf}::date)
          and ${notPending}
          ${nameFilter(params)}
      ) x
      where open is not null and open::numeric <> 0
      order by name nulls last, due_date nulls last, txn_date, ref_number, qb_id`,
  );
}

export interface Bucket {
  key: string;
  label: string;
  /** Inclusive day bounds; `max` undefined = open-ended. */
  min: number;
  max?: number;
}

/** Current, 1-N, N+1-2N, 2N+1-3N, > 3N days past due. */
export function agingBuckets(interval = 30): Bucket[] {
  const i = Math.max(1, interval);
  return [
    { key: 'current', label: 'Current', min: Number.NEGATIVE_INFINITY, max: 0 },
    { key: 'b1', label: `1 - ${i}`, min: 1, max: i },
    { key: 'b2', label: `${i + 1} - ${2 * i}`, min: i + 1, max: 2 * i },
    { key: 'b3', label: `${2 * i + 1} - ${3 * i}`, min: 2 * i + 1, max: 3 * i },
    { key: 'b4', label: `> ${3 * i}`, min: 3 * i + 1 },
  ];
}

export function bucketFor(days: number, buckets: Bucket[]): Bucket {
  return (
    buckets.find((b) => days >= b.min && (b.max === undefined || days <= b.max)) ?? buckets[0]!
  );
}

const intervalParam: ParamDef = {
  name: 'interval',
  label: 'Days per aging period',
  type: 'integer',
  default: 30,
  group: 'layout',
};

function asOfOf(params: ReportParams, today: string): string {
  return typeof params.asOf === 'string' ? params.asOf : today;
}

const AGING_NOTE =
  'Open balances are current read-model balances; aging is measured to the as-of date. ' +
  'For balances reconstructed at a past date use the QuickBooks aging report.';

function agingSummary(side: Side): SqlReportDefinition {
  const who = side === 'ar' ? 'Customer' : 'Vendor';
  return {
    name: `${side}-aging-summary`,
    title: side === 'ar' ? 'A/R Aging Summary' : 'A/P Aging Summary',
    description: `Open ${side === 'ar' ? 'receivables' : 'payables'} per ${who.toLowerCase()} by days past due.`,
    category: side === 'ar' ? 'Customers & Receivables' : 'Vendors & Payables',
    source: 'sql',
    params: [asOfParam, intervalParam, nameFilterParam(who)],
    async run(db, params, ctx) {
      const asOf = asOfOf(params, ctx.today);
      const buckets = agingBuckets(typeof params.interval === 'number' ? params.interval : 30);
      const items = await openItems(db, side, asOf, params);
      const columns: ReportColumn[] = [
        { key: 'name', title: who, type: 'text' },
        ...buckets.map((b) => ({ key: b.key, title: b.label, type: 'amount' as const })),
        { key: 'total', title: 'Total', type: 'amount' },
      ];
      const out = new ReportBuilder(columns);
      const grand: Record<string, string> = {};
      for (const [name, list] of groupBy(items, (r) => r.name ?? '(no name)')) {
        const sums: Record<string, string> = {};
        for (const it of list) {
          const days = it.due_date ? daysBetween(it.due_date, asOf) : 0;
          const b = bucketFor(days, buckets);
          sums[b.key] = Dec.add(sums[b.key], it.open);
          sums.total = Dec.add(sums.total, it.open);
        }
        const cells: Record<string, number | string> = { name };
        for (const k of [...buckets.map((b) => b.key), 'total']) {
          cells[k] = Dec.toNumber(sums[k]);
          grand[k] = Dec.add(grand[k], sums[k]);
        }
        out.data(cells);
      }
      out.total(
        'TOTAL',
        Object.fromEntries(
          [...buckets.map((b) => b.key), 'total'].map((k) => [k, Dec.toNumber(grand[k])]),
        ),
      );
      return out.output({ subtitle: `As of ${asOf}`, notes: [AGING_NOTE] });
    },
  };
}

const TYPE_LABELS: Record<string, string> = {
  Invoice: 'Invoice',
  Charge: 'Statement Charge',
  CreditMemo: 'Credit Memo',
  ReceivePayment: 'Payment',
  Bill: 'Bill',
  VendorCredit: 'Credit',
};

function agingDetail(side: Side): SqlReportDefinition {
  const who = side === 'ar' ? 'Customer' : 'Vendor';
  return {
    name: `${side}-aging-detail`,
    title: side === 'ar' ? 'A/R Aging Detail' : 'A/P Aging Detail',
    description: `Every open ${side === 'ar' ? 'receivable' : 'payable'} grouped by aging period.`,
    category: side === 'ar' ? 'Customers & Receivables' : 'Vendors & Payables',
    source: 'sql',
    params: [asOfParam, intervalParam, nameFilterParam(who)],
    async run(db, params, ctx) {
      const asOf = asOfOf(params, ctx.today);
      const buckets = agingBuckets(typeof params.interval === 'number' ? params.interval : 30);
      const items = await openItems(db, side, asOf, params);
      const columns: ReportColumn[] = [
        { key: 'type', title: 'Type', type: 'text' },
        { key: 'date', title: 'Date', type: 'date' },
        { key: 'num', title: 'Num', type: 'text' },
        { key: 'name', title: who, type: 'text' },
        { key: 'due', title: 'Due Date', type: 'date' },
        { key: 'aging', title: 'Aging', type: 'number' },
        { key: 'open', title: 'Open Balance', type: 'amount' },
      ];
      const out = new ReportBuilder(columns);
      const withDays = items.map((it) => ({
        ...it,
        days: it.due_date ? daysBetween(it.due_date, asOf) : 0,
      }));
      let grand = '0';
      // Same order as QuickBooks: Current first, oldest last.
      for (const b of buckets) {
        const list = withDays
          .filter((it) => bucketFor(it.days, buckets).key === b.key)
          .sort(
            (x, y) =>
              (x.due_date ?? '').localeCompare(y.due_date ?? '') ||
              (x.name ?? '').localeCompare(y.name ?? ''),
          );
        if (!list.length) continue;
        out.text(b.key === 'current' ? 'Current' : `${b.label} days past due`);
        let sub = '0';
        for (const it of list) {
          out.data(
            {
              type: TYPE_LABELS[it.type] ?? it.type,
              date: it.txn_date,
              num: it.ref_number,
              name: it.name,
              due: it.due_date,
              aging: it.days > 0 ? it.days : null,
              open: Dec.toNumber(it.open),
            },
            { indent: 1, ref: { type: it.type, id: it.qb_id } },
          );
          sub = Dec.add(sub, it.open);
        }
        out.subtotal(`Total ${b.key === 'current' ? 'Current' : b.label}`, {
          open: Dec.toNumber(sub),
        });
        grand = Dec.add(grand, sub);
      }
      out.total('TOTAL', { open: Dec.toNumber(grand) });
      return out.output({ subtitle: `As of ${asOf}`, notes: [AGING_NOTE] });
    },
  };
}

function openDocuments(side: Side): SqlReportDefinition {
  const ar = side === 'ar';
  return {
    name: ar ? 'open-invoices' : 'unpaid-bills',
    title: ar ? 'Open Invoices' : 'Unpaid Bills Detail',
    description: ar
      ? 'Invoices and statement charges with a balance, grouped by customer.'
      : 'Bills with an open amount, grouped by vendor.',
    category: ar ? 'Customers & Receivables' : 'Vendors & Payables',
    source: 'sql',
    params: [asOfParam, nameFilterParam(ar ? 'Customer' : 'Vendor')],
    async run(db, params, ctx) {
      const asOf = asOfOf(params, ctx.today);
      const items = await openItems(db, side, asOf, params, { chargesOnly: true });
      const columns: ReportColumn[] = [
        { key: 'type', title: 'Type', type: 'text' },
        { key: 'date', title: 'Date', type: 'date' },
        { key: 'num', title: 'Num', type: 'text' },
        { key: 'terms', title: 'Terms', type: 'text' },
        { key: 'due', title: 'Due Date', type: 'date' },
        { key: 'aging', title: 'Aging', type: 'number' },
        { key: 'open', title: 'Open Balance', type: 'amount' },
      ];
      const out = new ReportBuilder(columns);
      let grand = '0';
      for (const [name, list] of groupBy(items, (r) => r.name ?? '(no name)')) {
        out.text(name);
        let sub = '0';
        for (const it of list) {
          const days = it.due_date ? daysBetween(it.due_date, asOf) : 0;
          out.data(
            {
              type: TYPE_LABELS[it.type] ?? it.type,
              date: it.txn_date,
              num: it.ref_number,
              terms: it.terms,
              due: it.due_date,
              aging: days > 0 ? days : null,
              open: Dec.toNumber(it.open),
            },
            { indent: 1, ref: { type: it.type, id: it.qb_id } },
          );
          sub = Dec.add(sub, it.open);
        }
        out.subtotal(`Total ${name}`, { open: Dec.toNumber(sub) });
        grand = Dec.add(grand, sub);
      }
      out.total('TOTAL', { open: Dec.toNumber(grand) });
      return out.output({ subtitle: `As of ${asOf}` });
    },
  };
}

export const agingReports: SqlReportDefinition[] = [
  agingSummary('ar'),
  agingDetail('ar'),
  agingSummary('ap'),
  agingDetail('ap'),
  openDocuments('ar'),
  openDocuments('ap'),
];
