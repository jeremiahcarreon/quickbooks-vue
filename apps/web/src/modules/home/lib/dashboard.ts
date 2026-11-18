/**
 * Home dashboard figures computed from the read model: open and overdue
 * receivables, unpaid bills with aging buckets, and recent activity.
 */
import { listAll, listObjects } from '../../transactions/lib/api';
import { add, dec, ZERO, type Dec } from '../../transactions/lib/decimal';
import type { ObjectRow } from '../../transactions/lib/types';
import { txnSummary, type TxnSummary } from '../../centers/lib/centers';

export const AGING_BUCKETS = ['Current', '1-30', '31-60', '61-90', '> 90'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface OpenSummary {
  count: number;
  total: Dec;
  overdueCount: number;
  overdue: Dec;
  aging: Record<AgingBucket, Dec>;
  /** More rows exist than were read; totals are partial. */
  truncated: boolean;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function bucketFor(dueDate: string | undefined, today: string): AgingBucket {
  if (!dueDate) return 'Current';
  const late = daysBetween(dueDate, today);
  if (late <= 0) return 'Current';
  if (late <= 30) return '1-30';
  if (late <= 60) return '31-60';
  if (late <= 90) return '61-90';
  return '> 90';
}

/** Open balance of an invoice, charge or bill row. */
export function openBalance(row: ObjectRow): Dec {
  const d = row.data;
  return dec(d.BalanceRemaining ?? d.OpenAmount ?? d.AmountDue ?? ZERO);
}

export function summarizeOpen(
  rows: readonly ObjectRow[],
  today: string,
  truncated = false,
): OpenSummary {
  const aging = Object.fromEntries(AGING_BUCKETS.map((b) => [b, ZERO])) as Record<AgingBucket, Dec>;
  let count = 0;
  let total = ZERO;
  let overdueCount = 0;
  let overdue = ZERO;
  for (const r of rows) {
    const bal = openBalance(r);
    if (bal <= ZERO) continue;
    const due = typeof r.data.DueDate === 'string' ? r.data.DueDate : (r.txnDate ?? undefined);
    const bucket = bucketFor(due, today);
    count += 1;
    total = add(total, bal);
    aging[bucket] = add(aging[bucket], bal);
    if (bucket !== 'Current') {
      overdueCount += 1;
      overdue = add(overdue, bal);
    }
  }
  return { count, total, overdueCount, overdue, aging, truncated };
}

export const RECENT_TYPES = [
  'Invoice',
  'ReceivePayment',
  'SalesReceipt',
  'CreditMemo',
  'Estimate',
  'SalesOrder',
  'Bill',
  'BillPaymentCheck',
  'Check',
  'Deposit',
  'JournalEntry',
  'PurchaseOrder',
];

export interface RecentTxn extends TxnSummary {
  name?: string;
  modified?: string;
}

/** Latest modified transactions across types, newest first. */
export function mergeRecent(rows: readonly ObjectRow[], limit = 15): RecentTxn[] {
  return [...rows]
    .sort((a, b) => (b.timeModified ?? '').localeCompare(a.timeModified ?? ''))
    .slice(0, limit)
    .map((r) => ({ ...txnSummary(r), name: r.name, modified: r.timeModified }));
}

export async function loadOpen(type: 'Invoice' | 'Bill', today: string): Promise<OpenSummary> {
  const res = await listAll(type, { filter: { IsPaid: 'false' }, sort: 'txn_date' }, 5000);
  return summarizeOpen(res.items, today, res.truncated);
}

export async function loadRecent(limit = 15): Promise<RecentTxn[]> {
  const results = await Promise.allSettled(
    RECENT_TYPES.map((t) => listObjects(t, { sort: '-time_modified', pageSize: 8 })),
  );
  const rows = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []));
  return mergeRecent(rows, limit);
}
