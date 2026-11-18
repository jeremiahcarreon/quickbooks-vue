import { sql } from 'kysely';
import { catalog } from '@qbv/qbxml';
import type { ParamDef, ReportColumn } from '../types.js';
import {
  Dec,
  dateRangeFilter,
  dt,
  groupBy,
  nameFilter,
  nameFilterParam,
  notPending,
  num,
  pct,
  periodParams,
  periodSubtitle,
  ReportBuilder,
  resolvePeriod,
  rowsOf,
  txt,
  type SqlReportDefinition,
} from './common.js';

// ---------------------------------------------------------------- open orders

function openOrders(kind: 'so' | 'po'): SqlReportDefinition {
  const so = kind === 'so';
  const type = so ? 'SalesOrder' : 'PurchaseOrder';
  const who = so ? 'Customer' : 'Vendor';
  const doneFlag = so ? 'IsFullyInvoiced' : 'IsFullyReceived';
  const dateField = so ? 'ShipDate' : 'ExpectedDate';
  return {
    name: so ? 'open-sales-orders' : 'open-purchase-orders',
    title: so ? 'Open Sales Orders by Customer' : 'Open Purchase Orders by Vendor',
    description: so
      ? 'Sales orders not yet fully invoiced or closed.'
      : 'Purchase orders not yet fully received or closed.',
    category: so ? 'Sales' : 'Purchases',
    source: 'sql',
    params: [nameFilterParam(who)],
    async run(db, params) {
      const rows = await rowsOf(
        db,
        sql<{
          qb_id: string;
          name: string | null;
          txn_date: string | null;
          ref_number: string | null;
          other_date: string | null;
          memo: string | null;
          amount: string | null;
        }>`
          select qb_id, name, txn_date, ref_number, ${dt(dateField)}::text as other_date,
            ${txt('Memo')} as memo, ${num('TotalAmount')}::text as amount
          from qb_object
          where type = ${type} and deleted_at is null
            and coalesce(data->>${doneFlag}, 'false') <> 'true'
            and coalesce(data->>'IsManuallyClosed', 'false') <> 'true'
            ${nameFilter(params)}
          order by name nulls last, txn_date, ref_number`,
      );
      const columns: ReportColumn[] = [
        { key: 'type', title: 'Type', type: 'text' },
        { key: 'date', title: 'Date', type: 'date' },
        { key: 'num', title: 'Num', type: 'text' },
        { key: 'other', title: so ? 'Ship Date' : 'Expected', type: 'date' },
        { key: 'memo', title: 'Memo', type: 'text' },
        { key: 'amount', title: 'Amount', type: 'amount' },
      ];
      const out = new ReportBuilder(columns);
      let grand = '0';
      for (const [name, list] of groupBy(rows, (r) => r.name ?? '(no name)')) {
        out.text(name);
        let sub = '0';
        for (const r of list) {
          out.data(
            {
              type: so ? 'Sales Order' : 'Purchase Order',
              date: r.txn_date,
              num: r.ref_number,
              other: r.other_date,
              memo: r.memo,
              amount: Dec.toNumber(r.amount),
            },
            { indent: 1, ref: { type, id: r.qb_id } },
          );
          sub = Dec.add(sub, r.amount);
        }
        out.subtotal(`Total ${name}`, { amount: Dec.toNumber(sub) });
        grand = Dec.add(grand, sub);
      }
      out.total('TOTAL', { amount: Dec.toNumber(grand) });
      return out.output();
    },
  };
}

// ---------------------------------------------------------------- sales

const salesByCustomer: SqlReportDefinition = {
  name: 'sales-by-customer-summary',
  title: 'Sales by Customer Summary',
  description: 'Invoice and sales receipt subtotals less credit memos, per customer.',
  category: 'Sales',
  source: 'sql',
  params: [...periodParams('ThisMonthToDate'), nameFilterParam('Customer')],
  async run(db, params, ctx) {
    const range = resolvePeriod(params, ctx.today, 'ThisMonthToDate');
    const rows = await rowsOf(
      db,
      sql<{ name: string | null; entity_ref_id: string | null; amount: string }>`
        select name, max(entity_ref_id) as entity_ref_id,
          sum(case when type = 'CreditMemo' then -${num('Subtotal')} else ${num('Subtotal')} end)::text as amount
        from qb_object
        where deleted_at is null
          and type in ('Invoice', 'SalesReceipt', 'CreditMemo')
          and ${notPending}
          ${dateRangeFilter(range)}
          ${nameFilter(params)}
        group by name
        order by name nulls last`,
    );
    const total = Dec.sum(rows.map((r) => r.amount));
    const out = new ReportBuilder([
      { key: 'name', title: 'Customer', type: 'text' },
      { key: 'amount', title: 'Amount', type: 'amount' },
      { key: 'pct', title: '% of Sales', type: 'percent' },
    ]);
    for (const r of rows) {
      out.data(
        { name: r.name ?? '(no name)', amount: Dec.toNumber(r.amount), pct: pct(r.amount, total) },
        r.entity_ref_id ? { ref: { type: 'Customer', id: r.entity_ref_id } } : {},
      );
    }
    out.total('TOTAL', { amount: Dec.toNumber(total), pct: rows.length ? 100 : null });
    return out.output({ subtitle: periodSubtitle(range) });
  },
};

/** Sales line paths per transaction type (group lines included). */
const SALES_LINES: [string, string, 1 | -1][] = [
  ['Invoice', '$.InvoiceLineRet[*]', 1],
  ['Invoice', '$.InvoiceLineGroupRet[*].InvoiceLineRet[*]', 1],
  ['SalesReceipt', '$.SalesReceiptLineRet[*]', 1],
  ['SalesReceipt', '$.SalesReceiptLineGroupRet[*].SalesReceiptLineRet[*]', 1],
  ['CreditMemo', '$.CreditMemoLineRet[*]', -1],
  ['CreditMemo', '$.CreditMemoLineGroupRet[*].CreditMemoLineRet[*]', -1],
];

const salesByItem: SqlReportDefinition = {
  name: 'sales-by-item-summary',
  title: 'Sales by Item Summary',
  description:
    'Quantity and amount sold per item from invoice, sales receipt and credit memo lines.',
  category: 'Sales',
  source: 'sql',
  params: [
    ...periodParams('ThisMonthToDate'),
    {
      name: 'name',
      label: 'Item',
      type: 'string',
      group: 'filter',
      help: 'Contains (case-insensitive)',
    },
  ],
  async run(db, params, ctx) {
    const range = resolvePeriod(params, ctx.today, 'ThisMonthToDate');
    const unions = SALES_LINES.map(
      ([type, path, sign]) => sql`
        select l.line, ${sign}::int as sign
        from qb_object o
        cross join lateral jsonb_path_query(o.data, ${sql.lit(path)}::jsonpath) as l(line)
        where o.type = ${type} and o.deleted_at is null
          and coalesce(o.data->>'IsPending', 'false') <> 'true'
          ${dateRangeFilter(range, 'o.txn_date')}`,
    );
    const filter = typeof params.name === 'string' && params.name ? params.name : null;
    const rows = await rowsOf(
      db,
      sql<{
        item: string;
        item_id: string | null;
        item_type: string | null;
        qty: string | null;
        amount: string | null;
      }>`
        select g.*, (select i.type from qb_object i
                     where i.qb_id = g.item_id and i.type like 'Item%' limit 1) as item_type
        from (
        select item, max(item_id) as item_id, sum(qty * sign)::text as qty, sum(amount * sign)::text as amount
        from (
          select line#>>'{ItemRef,FullName}' as item, line#>>'{ItemRef,ListID}' as item_id,
            ${num('Quantity', 'line')} as qty, ${num('Amount', 'line')} as amount, sign
          from (${sql.join(unions, sql` union all `)}) lines
        ) x
        where item is not null
          ${filter ? sql`and item ilike ${`%${filter.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}` : sql``}
        group by item
        ) g
        order by item`,
    );
    const total = Dec.sum(rows.map((r) => r.amount));
    const out = new ReportBuilder([
      { key: 'item', title: 'Item', type: 'text' },
      { key: 'qty', title: 'Qty', type: 'quantity' },
      { key: 'amount', title: 'Amount', type: 'amount' },
      { key: 'pct', title: '% of Sales', type: 'percent' },
      { key: 'avg', title: 'Avg Price', type: 'price' },
    ]);
    let qtyTotal = '0';
    for (const r of rows) {
      const q = Number(r.qty ?? 0);
      out.data(
        {
          item: r.item,
          qty: r.qty === null ? null : Number(r.qty),
          amount: Dec.toNumber(r.amount),
          pct: pct(r.amount ?? '0', total),
          avg: q ? Math.round((Number(r.amount ?? 0) / q) * 100000) / 100000 : null,
        },
        r.item_id && r.item_type ? { ref: { type: r.item_type, id: r.item_id } } : {},
      );
      qtyTotal = Dec.add(qtyTotal, r.qty);
    }
    out.total('TOTAL', {
      qty: Number(qtyTotal),
      amount: Dec.toNumber(total),
      pct: rows.length ? 100 : null,
    });
    return out.output({ subtitle: periodSubtitle(range) });
  },
};

// ---------------------------------------------------------------- purchases

const PURCHASE_SIGNS: Record<string, 1 | -1> = {
  Bill: 1,
  ItemReceipt: 1,
  Check: 1,
  CreditCardCharge: 1,
  VendorCredit: -1,
  CreditCardCredit: -1,
};

const purchasesByVendor: SqlReportDefinition = {
  name: 'purchases-by-vendor-summary',
  title: 'Purchases by Vendor Summary',
  description: 'Bills, item receipts, checks and card charges less credits, per vendor.',
  category: 'Purchases',
  source: 'sql',
  params: [...periodParams('ThisMonthToDate'), nameFilterParam('Vendor')],
  async run(db, params, ctx) {
    const range = resolvePeriod(params, ctx.today, 'ThisMonthToDate');
    const types = Object.keys(PURCHASE_SIGNS);
    const sign = sql.raw(
      `case o.type ${types.map((t) => `when '${t}' then ${PURCHASE_SIGNS[t]}`).join(' ')} end`,
    );
    const rows = await rowsOf(
      db,
      sql<{ name: string | null; entity_ref_id: string | null; amount: string }>`
        select o.name, o.entity_ref_id, sum(o.amount * ${sign})::text as amount
        from qb_object o
        where o.deleted_at is null and o.amount is not null
          and o.type in (${sql.join(types)})
          and exists (select 1 from qb_object v
                      where v.type = 'Vendor' and v.qb_id = o.entity_ref_id and v.deleted_at is null)
          ${dateRangeFilter(range, 'o.txn_date')}
          ${nameFilter(params, 'o.name')}
        group by o.name, o.entity_ref_id
        order by o.name nulls last`,
    );
    const total = Dec.sum(rows.map((r) => r.amount));
    const out = new ReportBuilder([
      { key: 'name', title: 'Vendor', type: 'text' },
      { key: 'amount', title: 'Amount', type: 'amount' },
      { key: 'pct', title: '% of Purchases', type: 'percent' },
    ]);
    for (const r of rows) {
      out.data(
        { name: r.name ?? '(no name)', amount: Dec.toNumber(r.amount), pct: pct(r.amount, total) },
        r.entity_ref_id ? { ref: { type: 'Vendor', id: r.entity_ref_id } } : {},
      );
    }
    out.total('TOTAL', { amount: Dec.toNumber(total), pct: rows.length ? 100 : null });
    return out.output({ subtitle: periodSubtitle(range) });
  },
};

// ---------------------------------------------------------------- transaction list

/** Transaction entity types from the catalog (category txn). */
export function transactionTypes(): string[] {
  return Object.values(catalog.entities)
    .filter((e) => e.category === 'txn')
    .map((e) => e.name)
    .sort();
}

const txnTypeParam = (): ParamDef => ({
  name: 'txnType',
  label: 'Transaction types',
  type: 'multiEnum',
  options: transactionTypes(),
  group: 'filter',
});

function splitWords(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2');
}

const transactionListByDate: SqlReportDefinition = {
  name: 'transaction-list-by-date',
  title: 'Transaction List by Date',
  description: 'Every transaction in the period, oldest first.',
  category: 'Accountant & Taxes',
  source: 'sql',
  get params() {
    return [...periodParams('ThisMonthToDate'), txnTypeParam(), nameFilterParam('Name')];
  },
  async run(db, params, ctx) {
    const range = resolvePeriod(params, ctx.today, 'ThisMonthToDate');
    const all = transactionTypes();
    const selected = Array.isArray(params.txnType) && params.txnType.length ? params.txnType : all;
    const rows = await rowsOf(
      db,
      sql<{
        type: string;
        qb_id: string;
        txn_date: string | null;
        ref_number: string | null;
        name: string | null;
        memo: string | null;
        amount: string | null;
      }>`
        select type, qb_id, txn_date, ref_number, name, ${txt('Memo')} as memo, amount::text as amount
        from qb_object
        where deleted_at is null and type in (${sql.join(selected)})
          and txn_date is not null
          ${dateRangeFilter(range)}
          ${nameFilter(params)}
        order by txn_date, type, ref_number, qb_id
        limit 50000`,
    );
    const out = new ReportBuilder([
      { key: 'type', title: 'Type', type: 'text' },
      { key: 'date', title: 'Date', type: 'date' },
      { key: 'num', title: 'Num', type: 'text' },
      { key: 'name', title: 'Name', type: 'text' },
      { key: 'memo', title: 'Memo', type: 'text' },
      { key: 'amount', title: 'Amount', type: 'amount' },
    ]);
    for (const r of rows) {
      out.data(
        {
          type: splitWords(r.type),
          date: r.txn_date,
          num: r.ref_number,
          name: r.name,
          memo: r.memo,
          amount: r.amount === null ? null : Dec.toNumber(r.amount),
        },
        { ref: { type: r.type, id: r.qb_id } },
      );
    }
    const notes =
      rows.length >= 50000 ? ['Limited to the first 50,000 transactions; narrow the period.'] : [];
    return out.output({ subtitle: periodSubtitle(range), notes });
  },
};

// ---------------------------------------------------------------- inventory

const inventoryValuation: SqlReportDefinition = {
  name: 'inventory-valuation-summary',
  title: 'Inventory Valuation Summary',
  description: 'Quantity on hand, average cost and asset and retail values per inventory item.',
  category: 'Inventory',
  source: 'sql',
  params: [
    {
      name: 'name',
      label: 'Item',
      type: 'string',
      group: 'filter',
      help: 'Contains (case-insensitive)',
    },
    {
      name: 'includeInactive',
      label: 'Include inactive items',
      type: 'boolean',
      default: false,
      group: 'filter',
    },
  ],
  async run(db, params) {
    const rows = await rowsOf(
      db,
      sql<{
        type: string;
        qb_id: string;
        name: string | null;
        sublevel: string | null;
        descr: string | null;
        qoh: string | null;
        avg: string | null;
        price: string | null;
        asset: string | null;
        retail: string | null;
      }>`
        select type, qb_id, name, data->>'Sublevel' as sublevel,
          coalesce(${txt('SalesDesc')}, ${txt('PurchaseDesc')}) as descr,
          ${num('QuantityOnHand')}::text as qoh, ${num('AverageCost')}::text as avg,
          ${num('SalesPrice')}::text as price,
          round(coalesce(${num('QuantityOnHand')}, 0) * coalesce(${num('AverageCost')}, 0), 2)::text as asset,
          round(coalesce(${num('QuantityOnHand')}, 0) * coalesce(${num('SalesPrice')}, 0), 2)::text as retail
        from qb_object
        where type in ('ItemInventory', 'ItemInventoryAssembly') and deleted_at is null
          ${params.includeInactive === true ? sql`` : sql`and coalesce(is_active, true)`}
          ${nameFilter(params)}
        order by name`,
    );
    const assetTotal = Dec.sum(rows.map((r) => r.asset));
    const retailTotal = Dec.sum(rows.map((r) => r.retail));
    const out = new ReportBuilder([
      { key: 'item', title: 'Item', type: 'text' },
      { key: 'desc', title: 'Description', type: 'text' },
      { key: 'qoh', title: 'On Hand', type: 'quantity' },
      { key: 'avg', title: 'Avg Cost', type: 'price' },
      { key: 'asset', title: 'Asset Value', type: 'amount' },
      { key: 'assetPct', title: '% of Tot Asset', type: 'percent' },
      { key: 'price', title: 'Sales Price', type: 'price' },
      { key: 'retail', title: 'Retail Value', type: 'amount' },
      { key: 'retailPct', title: '% of Tot Retail', type: 'percent' },
    ]);
    let qoh = '0';
    for (const r of rows) {
      const name = r.name ?? '';
      out.data(
        {
          item: name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name,
          desc: r.descr,
          qoh: r.qoh === null ? null : Number(r.qoh),
          avg: r.avg === null ? null : Number(r.avg),
          asset: Dec.toNumber(r.asset),
          assetPct: pct(r.asset ?? '0', assetTotal),
          price: r.price === null ? null : Number(r.price),
          retail: Dec.toNumber(r.retail),
          retailPct: pct(r.retail ?? '0', retailTotal),
        },
        { indent: Number(r.sublevel ?? 0) || 0, ref: { type: r.type, id: r.qb_id }, label: name },
      );
      qoh = Dec.add(qoh, r.qoh);
    }
    out.total('TOTAL', {
      qoh: Number(qoh),
      asset: Dec.toNumber(assetTotal),
      assetPct: rows.length ? 100 : null,
      retail: Dec.toNumber(retailTotal),
      retailPct: rows.length ? 100 : null,
    });
    return out.output({
      notes: ['Values use the current quantity on hand and average cost from the item list.'],
    });
  },
};

export const activityReports: SqlReportDefinition[] = [
  openOrders('so'),
  openOrders('po'),
  salesByCustomer,
  salesByItem,
  purchasesByVendor,
  transactionListByDate,
  inventoryValuation,
];
