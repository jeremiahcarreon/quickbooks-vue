import { sql } from 'kysely';
import type { Db } from '@qbv/db';
import type { ReportColumn, ReportParams } from '../types.js';
import {
  Dec,
  dateRangeFilter,
  groupBy,
  nameFilter,
  nameFilterParam,
  num,
  periodParams,
  periodSubtitle,
  ReportBuilder,
  resolvePeriod,
  rowsOf,
  txt,
  type SqlReportDefinition,
} from './common.js';

type Side = 'ar' | 'ap';

const includeZeroParam = {
  name: 'includeZero',
  label: 'Include zero balances',
  type: 'boolean' as const,
  default: false,
  group: 'filter' as const,
};

function balanceSummary(side: Side): SqlReportDefinition {
  const ar = side === 'ar';
  const who = ar ? 'Customer' : 'Vendor';
  return {
    name: ar ? 'customer-balance-summary' : 'vendor-balance-summary',
    title: ar ? 'Customer Balance Summary' : 'Vendor Balance Summary',
    description: `Current balance of every ${who.toLowerCase()} (from the ${who} list).`,
    category: ar ? 'Customers & Receivables' : 'Vendors & Payables',
    source: 'sql',
    params: [nameFilterParam(who), includeZeroParam],
    async run(db, params) {
      const includeZero = params.includeZero === true;
      const rows = await rowsOf(
        db,
        sql<{
          qb_id: string;
          name: string | null;
          balance: string | null;
          total: string | null;
          sublevel: string | null;
        }>`
          select qb_id, name, ${num('Balance')}::text as balance,
            ${ar ? num('TotalBalance') : num('Balance')}::text as total,
            data->>'Sublevel' as sublevel
          from qb_object
          where type = ${who} and deleted_at is null
            ${nameFilter(params)}
          order by name`,
      );
      const columns: ReportColumn[] = [
        { key: 'name', title: who, type: 'text' },
        { key: 'balance', title: 'Balance', type: 'amount' },
      ];
      const out = new ReportBuilder(columns);
      let grand = '0';
      for (const r of rows) {
        if (!includeZero && Dec.isZero(r.total) && Dec.isZero(r.balance)) continue;
        const name = r.name ?? '';
        // Jobs show their own name under their customer.
        const short = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
        out.data(
          { name: short, balance: Dec.toNumber(r.balance) },
          { indent: Number(r.sublevel ?? 0) || 0, ref: { type: who, id: r.qb_id }, label: name },
        );
        grand = Dec.add(grand, r.balance);
      }
      out.total('TOTAL', { balance: Dec.toNumber(grand) });
      return out.output();
    },
  };
}

interface LedgerRow {
  type: string;
  qb_id: string;
  ref_number: string | null;
  txn_date: string | null;
  name: string | null;
  memo: string | null;
  amount: string;
}

/** Signed effect on the A/R or A/P balance, from the extracted `amount` column. */
const LEDGER_SIGNS: Record<Side, Record<string, 1 | -1>> = {
  ar: { Invoice: 1, Charge: 1, ARRefundCreditCard: 1, CreditMemo: -1, ReceivePayment: -1 },
  ap: { Bill: 1, VendorCredit: -1, BillPaymentCheck: -1, BillPaymentCreditCard: -1 },
};

const TYPE_LABELS: Record<string, string> = {
  Invoice: 'Invoice',
  Charge: 'Statement Charge',
  ARRefundCreditCard: 'Credit Card Refund',
  CreditMemo: 'Credit Memo',
  ReceivePayment: 'Payment',
  Bill: 'Bill',
  VendorCredit: 'Credit',
  BillPaymentCheck: 'Bill Pmt -Check',
  BillPaymentCreditCard: 'Bill Pmt -CCard',
};

async function ledger(
  db: Db,
  side: Side,
  params: ReportParams,
  before?: string,
  range?: { from?: string; to?: string },
) {
  const signs = LEDGER_SIGNS[side];
  const types = Object.keys(signs);
  const signExpr = sql.raw(
    `case type ${types.map((t) => `when '${t}' then ${signs[t]}`).join(' ')} end`,
  );
  return rowsOf(
    db,
    sql<LedgerRow>`
      select type, qb_id, ref_number, txn_date, name, ${txt('Memo')} as memo,
        (amount * ${signExpr})::text as amount
      from qb_object
      where deleted_at is null and amount is not null
        and type in (${sql.join(types)})
        and coalesce(data->>'IsPending', 'false') <> 'true'
        ${before ? sql`and txn_date < ${before}::date` : sql``}
        ${range ? dateRangeFilter(range) : sql``}
        ${nameFilter(params)}
      order by name nulls last, txn_date nulls first, time_created, qb_id`,
  );
}

function balanceDetail(side: Side): SqlReportDefinition {
  const ar = side === 'ar';
  const who = ar ? 'Customer' : 'Vendor';
  return {
    name: ar ? 'customer-balance-detail' : 'vendor-balance-detail',
    title: ar ? 'Customer Balance Detail' : 'Vendor Balance Detail',
    description: ar
      ? 'Invoices, charges, credits and payments per customer with a running balance.'
      : 'Bills, credits and bill payments per vendor with a running balance.',
    category: ar ? 'Customers & Receivables' : 'Vendors & Payables',
    source: 'sql',
    params: [...periodParams('All'), nameFilterParam(who)],
    async run(db, params, ctx) {
      const range = resolvePeriod(params, ctx.today, 'All');
      const rows = await ledger(db, side, params, undefined, range);
      const opening = new Map<string, string>();
      if (range.from) {
        for (const r of await ledger(db, side, params, range.from)) {
          const k = r.name ?? '(no name)';
          opening.set(k, Dec.add(opening.get(k), r.amount));
        }
      }
      const columns: ReportColumn[] = [
        { key: 'type', title: 'Type', type: 'text' },
        { key: 'date', title: 'Date', type: 'date' },
        { key: 'num', title: 'Num', type: 'text' },
        { key: 'memo', title: 'Memo', type: 'text' },
        { key: 'amount', title: 'Amount', type: 'amount' },
        { key: 'balance', title: 'Balance', type: 'amount' },
      ];
      const out = new ReportBuilder(columns);
      const groups = groupBy(rows, (r) => r.name ?? '(no name)');
      for (const name of opening.keys()) if (!groups.has(name)) groups.set(name, []);
      const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
      let grandAmount = '0';
      let grandBalance = '0';
      for (const name of names) {
        const list = groups.get(name)!;
        const open = opening.get(name) ?? '0';
        if (!list.length && Dec.isZero(open)) continue;
        out.text(name);
        let bal = open;
        if (range.from && !Dec.isZero(open)) {
          out.data({ type: 'Beginning balance', balance: Dec.toNumber(open) }, { indent: 1 });
        }
        let sub = '0';
        for (const r of list) {
          bal = Dec.add(bal, r.amount);
          sub = Dec.add(sub, r.amount);
          out.data(
            {
              type: TYPE_LABELS[r.type] ?? r.type,
              date: r.txn_date,
              num: r.ref_number,
              memo: r.memo,
              amount: Dec.toNumber(r.amount),
              balance: Dec.toNumber(bal),
            },
            { indent: 1, ref: { type: r.type, id: r.qb_id } },
          );
        }
        out.subtotal(`Total ${name}`, { amount: Dec.toNumber(sub), balance: Dec.toNumber(bal) });
        grandAmount = Dec.add(grandAmount, sub);
        grandBalance = Dec.add(grandBalance, bal);
      }
      out.total('TOTAL', {
        amount: Dec.toNumber(grandAmount),
        balance: Dec.toNumber(grandBalance),
      });
      return out.output({
        subtitle: periodSubtitle(range),
        notes: [
          'Amounts are transaction totals from the read model; discounts and journal entries posted to ' +
            `${ar ? 'A/R' : 'A/P'} are not included.`,
        ],
      });
    },
  };
}

export const balanceReports: SqlReportDefinition[] = [
  balanceSummary('ar'),
  balanceDetail('ar'),
  balanceSummary('ap'),
  balanceDetail('ap'),
];
