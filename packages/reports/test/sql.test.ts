import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markDeleted, type Db } from '@qbv/db';
import { createTestDatabase, type TestDatabase } from '@qbv/db/testing';
import { getReport, runReport, sqlReports, type ReportResult } from '../src/index.js';
import { seedFixtures } from './fixtures.js';

let t: TestDatabase;
let db: Db;
// The reports' "today" when not given explicitly.
const now = () => new Date(2024, 2, 31, 12, 0, 0);

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  await seedFixtures(db);
});
afterAll(async () => {
  await t?.destroy();
});

async function run(name: string, params: Record<string, unknown> = {}): Promise<ReportResult> {
  const out = await runReport({ db, now }, name, params);
  if (out.status !== 'ready') throw new Error('SQL reports are always ready');
  return out.result;
}

const dataRows = (r: ReportResult) => r.rows.filter((x) => x.kind === 'data');
const rowsBy = (r: ReportResult, key: string) =>
  Object.fromEntries(dataRows(r).map((x) => [String(x.cells[key]), x.cells]));

describe('SQL report catalog', () => {
  it('has every operational report', () => {
    expect(sqlReports.map((r) => r.name).sort()).toEqual(
      [
        'ap-aging-detail',
        'ap-aging-summary',
        'ar-aging-detail',
        'ar-aging-summary',
        'customer-balance-detail',
        'customer-balance-summary',
        'inventory-valuation-summary',
        'open-invoices',
        'open-purchase-orders',
        'open-sales-orders',
        'purchases-by-vendor-summary',
        'sales-by-customer-summary',
        'sales-by-item-summary',
        'transaction-list-by-date',
        'unpaid-bills',
        'vendor-balance-detail',
        'vendor-balance-summary',
      ].sort(),
    );
  });

  it('runs every SQL report with default params on the fixtures', async () => {
    for (const def of sqlReports) {
      const r = await run(def.name);
      expect(r.meta.source).toBe('sql');
      expect(r.meta.name).toBe(def.name);
      expect(r.columns.length).toBeGreaterThan(0);
      for (const row of r.rows)
        for (const k of Object.keys(row.cells)) expect(r.columns.map((c) => c.key)).toContain(k);
    }
  });

  it('runs on an empty database', async () => {
    const empty = await createTestDatabase();
    try {
      for (const def of sqlReports) {
        const out = await runReport({ db: empty.db, now }, def.name, {});
        expect(out.status).toBe('ready');
      }
    } finally {
      await empty.destroy();
    }
  });
});

describe('A/R and A/P aging', () => {
  it('A/R aging summary buckets open items by days past due', async () => {
    const r = await run('ar-aging-summary', { asOf: '2024-03-31' });
    expect(r.meta.subtitle).toBe('As of 2024-03-31');
    const by = rowsBy(r, 'name');
    expect(by.Acme).toEqual({
      name: 'Acme',
      current: 500,
      b1: -100,
      b2: 600,
      b3: 0,
      b4: 0,
      total: 1000,
    });
    expect(by['Beta:Job1']).toMatchObject({ b4: 300, total: 300 });
    expect(Object.keys(by)).toHaveLength(2);
    expect(r.totals).toMatchObject({
      current: 500,
      b1: -100,
      b2: 600,
      b3: 0,
      b4: 300,
      total: 1300,
    });
    expect(r.columns.map((c) => c.title)).toEqual([
      'Customer',
      'Current',
      '1 - 30',
      '31 - 60',
      '61 - 90',
      '> 90',
      'Total',
    ]);
  });

  it('A/R aging uses the as-of date (excludes later txns) and the interval', async () => {
    const r = await run('ar-aging-summary', { asOf: '2024-04-30', interval: '15' });
    // INV-6 (2024-04-05) now included; INV-1 (90 days) and CM-1 (60 days) fall in > 45.
    expect(rowsBy(r, 'name').Acme).toMatchObject({ current: 50, b1: 500, b4: 500, total: 1050 });
  });

  it('A/R aging detail groups by period with subtotals and links', async () => {
    const r = await run('ar-aging-detail', { asOf: '2024-03-31' });
    expect(r.rows.filter((x) => x.kind === 'text').map((x) => x.label)).toEqual([
      'Current',
      '1 - 30 days past due',
      '31 - 60 days past due',
      '> 90 days past due',
    ]);
    const inv1 = dataRows(r).find((x) => x.cells.num === 'INV-1')!;
    expect(inv1.cells).toMatchObject({ type: 'Invoice', due: '2024-01-31', aging: 60, open: 600 });
    expect(inv1.ref).toEqual({ type: 'Invoice', id: 'T-INV1' });
    expect(inv1.indent).toBe(1);
    expect(r.rows.filter((x) => x.kind === 'subtotal').map((x) => x.cells.open)).toEqual([
      500, -100, 600, 300,
    ]);
    expect(r.totals?.open).toBe(1300);
  });

  it('A/P aging summary and detail', async () => {
    const s = await run('ap-aging-summary', { asOf: '2024-03-31' });
    const by = rowsBy(s, 'name');
    expect(by['Paper Co']).toMatchObject({ current: 300, b1: -50, total: 250 });
    expect(by['Rent LLC']).toMatchObject({ b2: 1000, total: 1000 });
    expect(s.totals?.total).toBe(1250);
    const d = await run('ap-aging-detail', { asOf: '2024-03-31' });
    expect(d.totals?.open).toBe(1250);
    expect(
      dataRows(d)
        .map((x) => x.cells.num)
        .sort(),
    ).toEqual(['B-1', 'B-3', 'VC-1']);
  });

  it('name filter narrows the rows', async () => {
    const r = await run('ar-aging-summary', { asOf: '2024-03-31', name: 'job' });
    expect(dataRows(r).map((x) => x.cells.name)).toEqual(['Beta:Job1']);
  });

  it('soft-deleted transactions are excluded', async () => {
    const t2 = await createTestDatabase();
    try {
      await seedFixtures(t2.db);
      await markDeleted(t2.db, 'Invoice', ['T-INV3']);
      const out = await runReport({ db: t2.db, now }, 'ar-aging-summary', { asOf: '2024-03-31' });
      expect(out.status === 'ready' && out.result.totals?.total).toBe(1000);
    } finally {
      await t2.destroy();
    }
  });
});

describe('open documents', () => {
  it('open invoices grouped by customer', async () => {
    const r = await run('open-invoices', { asOf: '2024-03-31' });
    expect(r.rows.filter((x) => x.kind === 'text').map((x) => x.label)).toEqual([
      'Acme',
      'Beta:Job1',
    ]);
    expect(dataRows(r).map((x) => x.cells.num)).toEqual(['INV-1', 'INV-2', 'INV-3']);
    expect(dataRows(r)[0]!.cells.terms).toBe('Net 30');
    expect(r.rows.find((x) => x.kind === 'subtotal')).toMatchObject({
      label: 'Total Acme',
      cells: { open: 1100 },
    });
    expect(r.totals?.open).toBe(1400);
  });

  it('unpaid bills grouped by vendor (OpenAmount, falling back to AmountDue)', async () => {
    const r = await run('unpaid-bills', { asOf: '2024-03-31' });
    expect(dataRows(r).map((x) => [x.cells.num, x.cells.open])).toEqual([
      ['B-1', 300],
      ['B-3', 1000],
    ]);
    expect(r.totals?.open).toBe(1300);
  });

  it('open sales orders and purchase orders', async () => {
    const so = await run('open-sales-orders');
    expect(dataRows(so).map((x) => x.cells)).toEqual([
      {
        type: 'Sales Order',
        date: '2024-02-20',
        num: 'SO-1',
        other: '2024-04-10',
        memo: 'Rush',
        amount: 250,
      },
    ]);
    const po = await run('open-purchase-orders');
    expect(dataRows(po).map((x) => [x.cells.num, x.cells.other, x.cells.amount])).toEqual([
      ['PO-1', '2024-04-01', 80],
    ]);
    expect(po.totals?.amount).toBe(80);
  });
});

describe('balances', () => {
  it('customer balance summary with job indentation', async () => {
    const r = await run('customer-balance-summary');
    expect(dataRows(r).map((x) => [x.label, x.cells.name, x.indent, x.cells.balance])).toEqual([
      ['Acme', 'Acme', 0, 1050],
      ['Beta', 'Beta', 0, 0],
      ['Beta:Job1', 'Job1', 1, 300],
    ]);
    expect(r.totals?.balance).toBe(1350);
    const all = await run('customer-balance-summary', { includeZero: 'true' });
    expect(dataRows(all)).toHaveLength(5);
  });

  it('customer balance detail runs a balance per customer', async () => {
    const r = await run('customer-balance-detail');
    const acme = dataRows(r).filter(
      (x) => r.rows.indexOf(x) < r.rows.findIndex((y) => y.label === 'Total Acme'),
    );
    expect(acme.map((x) => [x.cells.num, x.cells.amount, x.cells.balance])).toEqual([
      ['INV-1', 1000, 1000],
      ['INV-4', 200, 1200],
      ['1001', -600, 600],
      ['CM-1', -100, 500],
      ['INV-2', 500, 1000],
      ['INV-6', 50, 1050],
    ]);
    expect(r.totals).toMatchObject({ balance: 1350 });
  });

  it('balance detail with a start date shows a beginning balance', async () => {
    const r = await run('vendor-balance-detail', { from: '2024-02-01' });
    const paper = r.rows.slice(r.rows.findIndex((x) => x.label === 'Paper Co'));
    expect(paper[1]!.cells).toMatchObject({ type: 'Beginning balance', balance: 200 });
    expect(r.rows.find((x) => x.label === 'Total Paper Co')!.cells).toMatchObject({
      amount: 50,
      balance: 250,
    });
    expect(r.totals).toMatchObject({ balance: 1250 });
    expect(r.meta.subtitle).toBe('From 2024-02-01');
  });

  it('vendor balance summary', async () => {
    const r = await run('vendor-balance-summary');
    expect(dataRows(r).map((x) => [x.cells.name, x.cells.balance])).toEqual([
      ['Paper Co', 250],
      ['Rent LLC', 1000],
    ]);
  });
});

describe('sales, purchases, transactions, inventory', () => {
  const q1 = { from: '2024-01-01', to: '2024-03-31' };

  it('sales by customer nets credit memos and skips pending', async () => {
    const r = await run('sales-by-customer-summary', q1);
    expect(dataRows(r).map((x) => [x.cells.name, x.cells.amount])).toEqual([
      ['Acme', 1600],
      ['Cash Cust', 75],
    ]);
    expect(r.totals?.amount).toBe(1675);
    expect(rowsBy(r, 'name')['Cash Cust']!.pct).toBe(4.48);
    expect(r.meta.subtitle).toBe('2024-01-01 through 2024-03-31');
  });

  it('sales by customer defaults to this month to date', async () => {
    const r = await run('sales-by-customer-summary');
    expect(r.meta.params).toMatchObject({ dateMacro: 'ThisMonthToDate' });
    expect(r.meta.subtitle).toBe('2024-03-01 through 2024-03-31');
    expect(r.totals?.amount).toBe(475); // INV-2 500 - CM-1 100 + SR-1 75
  });

  it('sales by item reads lines, including group lines', async () => {
    const r = await run('sales-by-item-summary', q1);
    const by = rowsBy(r, 'item');
    expect(by.Widget).toMatchObject({ qty: 15, amount: 775 });
    expect(by.Service).toMatchObject({ qty: 9, amount: 900, avg: 100 });
    expect(r.totals).toMatchObject({ qty: 24, amount: 1675 });
    expect(dataRows(r).find((x) => x.cells.item === 'Widget')!.ref).toEqual({
      type: 'ItemInventory',
      id: 'I1',
    });
  });

  it('purchases by vendor counts vendors only', async () => {
    const r = await run('purchases-by-vendor-summary', q1);
    expect(dataRows(r).map((x) => [x.cells.name, x.cells.amount])).toEqual([
      ['Paper Co', 450],
      ['Rent LLC', 1150],
    ]);
    expect(r.totals?.amount).toBe(1600);
  });

  it('transaction list by date, optionally filtered by type', async () => {
    const r = await run('transaction-list-by-date', { dateMacro: 'ThisMonth' });
    const nums = dataRows(r).map((x) => x.cells.num);
    expect(nums).toHaveLength(9);
    expect(dataRows(r)[0]!.cells.date).toBe('2024-03-01');
    expect(dataRows(r).map((x) => x.cells.date)).toEqual(
      [...dataRows(r).map((x) => x.cells.date)].sort(),
    );
    const checks = await run('transaction-list-by-date', { ...q1, txnType: 'Check,Bill' });
    expect(
      dataRows(checks)
        .map((x) => x.cells.type)
        .sort(),
    ).toEqual(['Bill', 'Bill', 'Bill', 'Check', 'Check']);
    const txnTypes = getReport('transaction-list-by-date')!.params.find(
      (p) => p.name === 'txnType',
    )!.options!;
    expect(txnTypes).toEqual(expect.arrayContaining(['Invoice', 'Bill', 'JournalEntry', 'Check']));
  });

  it('inventory valuation summary', async () => {
    const r = await run('inventory-valuation-summary');
    const by = Object.fromEntries(dataRows(r).map((x) => [x.label, x]));
    expect(Object.keys(by)).toEqual(['Kit', 'Parts:Gadget', 'Widget']);
    expect(by.Widget!.cells).toMatchObject({
      qoh: 10,
      avg: 20,
      asset: 200,
      assetPct: 66.67,
      retail: 500,
      desc: 'A widget',
    });
    expect(by['Parts:Gadget']!.cells).toMatchObject({ item: 'Gadget', desc: 'Gadget bought' });
    expect(by['Parts:Gadget']!.indent).toBe(1);
    expect(r.totals).toMatchObject({ qoh: 17, asset: 300, retail: 650 });
    const all = await run('inventory-valuation-summary', { includeInactive: 'true' });
    expect(dataRows(all)).toHaveLength(4);
  });
});
