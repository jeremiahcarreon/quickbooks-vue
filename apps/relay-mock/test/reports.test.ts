import { type ParsedRs } from '@qbv/qbxml';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedSampleCompany } from '../src/seed.js';
import { ok, testEngine, type TestEngine } from './helpers.js';

interface Row {
  kind: string;
  n: number;
  cols: Record<string, string>;
  value?: string;
}

/** Flatten ReportData back into document order using rowNumber. */
function rows(rs: ParsedRs): Row[] {
  const report = (rs.body.ReportRet ?? {}) as Record<string, unknown>;
  const data = (report.ReportData ?? {}) as Record<string, Record<string, unknown>[]>;
  const out: Row[] = [];
  for (const kind of ['DataRow', 'TextRow', 'SubtotalRow', 'TotalRow']) {
    for (const r of data[kind] ?? []) {
      const cols: Record<string, string> = {};
      for (const c of (r.ColData ?? []) as Record<string, string>[])
        cols[c['@colID']!] = c['@value'] ?? '';
      out.push({
        kind,
        n: Number(r['@rowNumber']),
        cols,
        value: r['@value'] as string | undefined,
      });
    }
  }
  return out.sort((a, b) => a.n - b.n);
}

const amount = (r: Row | undefined, col = '2') => Number(r?.cols[col] ?? NaN);
const find = (rs: Row[], label: string) => rs.find((r) => r.cols['1'] === label);

describe('reports over the sample company', () => {
  let t: TestEngine;
  beforeAll(() => {
    t = testEngine('2026-11-17T18:00:00Z');
    seedSampleCompany(t.engine);
  });

  it('Profit & Loss', () => {
    const rs = ok(
      t.rq(
        'GeneralSummaryReportQueryRq',
        {
          GeneralSummaryReportType: 'ProfitAndLossStandard',
          ReportPeriod: { FromReportDate: '2026-01-01', ToReportDate: '2026-10-31' },
        },
        { requestID: 'pl' },
      ),
    );
    expect(rs.requestID).toBe('pl');
    const report = rs.body.ReportRet as Record<string, unknown>;
    expect(report.ReportTitle).toBe('Profit & Loss');
    expect(report.ReportSubtitle).toBe('January 1 through October 31, 2026');
    expect(report.ReportBasis).toBe('Accrual');
    const r = rows(rs);
    expect(Number(report.NumRows)).toBe(r.length);
    const income = amount(find(r, 'Total Income'));
    const cogs = amount(find(r, 'Total COGS'));
    const expense = amount(find(r, 'Total Expense'));
    expect(income).toBeGreaterThan(20_000);
    expect(amount(find(r, 'Gross Profit'))).toBeCloseTo(income - cogs, 2);
    const net = amount(find(r, 'Net Income'));
    const other = amount(find(r, 'Net Other Income')) || 0;
    expect(net).toBeCloseTo(income - cogs - expense + other, 2);
    expect(r.find((x) => x.kind === 'TotalRow')!.cols['1']).toBe('Net Income');
    // Account rows sum to their section total.
    const firstText = r.findIndex((x) => x.kind === 'TextRow' && x.value === 'Income');
    const end = r.findIndex((x) => x.cols['1'] === 'Total Income');
    const sum = r.slice(firstText + 1, end).reduce((s, x) => s + amount(x), 0);
    expect(sum).toBeCloseTo(income, 2);
  });

  it('Balance Sheet balances and agrees with the P&L', () => {
    const asOf = '2026-10-31';
    const bs = rows(
      ok(
        t.rq('GeneralSummaryReportQueryRq', {
          GeneralSummaryReportType: 'BalanceSheetStandard',
          ReportPeriod: { ToReportDate: asOf },
        }),
      ),
    );
    const assets = amount(find(bs, 'TOTAL ASSETS'));
    const le = amount(find(bs, 'TOTAL LIABILITIES & EQUITY'));
    expect(assets).toBeGreaterThan(0);
    expect(le).toBeCloseTo(assets, 2);
    const pl = rows(
      ok(
        t.rq('GeneralSummaryReportQueryRq', {
          GeneralSummaryReportType: 'ProfitAndLossStandard',
          ReportPeriod: { FromReportDate: '2026-01-01', ToReportDate: asOf },
        }),
      ),
    );
    expect(amount(find(bs, 'Net Income'))).toBeCloseTo(amount(find(pl, 'Net Income')), 2);
    // A/R on the balance sheet equals open invoices.
    const ar = amount(find(bs, 'Accounts Receivable'));
    const open = t
      .rq('InvoiceQueryRq', { PaidStatus: 'NotPaidOnly' })
      .rets.reduce((s, i) => s + Number(i.BalanceRemaining), 0);
    const credits = t
      .rq('CreditMemoQueryRq', {})
      .rets.reduce((s, c) => s + Number(c.CreditRemaining), 0);
    expect(ar).toBeCloseTo(open - credits, 2);
  });

  it('Trial Balance debits equal credits', () => {
    const tb = rows(
      ok(
        t.rq('GeneralSummaryReportQueryRq', {
          GeneralSummaryReportType: 'TrialBalance',
          ReportDateMacro: 'Today',
        }),
      ),
    );
    const total = tb.find((r) => r.kind === 'TotalRow')!;
    expect(Number(total.cols['2'])).toBeGreaterThan(0);
    expect(Number(total.cols['2'])).toBeCloseTo(Number(total.cols['3']), 2);
  });

  it('A/R and A/P aging', () => {
    const ar = ok(
      t.rq('AgingReportQueryRq', {
        AgingReportType: 'ARAgingSummary',
        ReportPeriod: { ToReportDate: '2026-11-17' },
      }),
    );
    expect((ar.body.ReportRet as Record<string, unknown>).ReportSubtitle).toBe(
      'As of November 17, 2026',
    );
    const r = rows(ar);
    const total = r.find((x) => x.kind === 'TotalRow')!;
    const buckets = ['2', '3', '4', '5', '6'].reduce((s, c) => s + Number(total.cols[c]), 0);
    expect(Number(total.cols['7'])).toBeCloseTo(buckets, 2);
    const customers = t.rq('CustomerQueryRq', {}).rets;
    const balance = customers.reduce((s, c) => s + Number(c.Balance), 0);
    const unused = t
      .rq('ReceivePaymentQueryRq', {})
      .rets.reduce((s, p) => s + Number(p.UnusedPayment ?? 0), 0);
    expect(Number(total.cols['7'])).toBeCloseTo(balance + unused, 2);
    const detail = rows(ok(t.rq('AgingReportQueryRq', { AgingReportType: 'ARAgingDetail' })));
    expect(Number(detail.find((x) => x.kind === 'TotalRow')!.cols['8'])).toBeCloseTo(
      Number(total.cols['7']),
      2,
    );
    const ap = rows(ok(t.rq('AgingReportQueryRq', { AgingReportType: 'APAgingSummary' })));
    expect(ap.find((x) => x.kind === 'TotalRow')).toBeDefined();
  });

  it('balance summaries', () => {
    const cb = rows(
      ok(
        t.rq('GeneralSummaryReportQueryRq', { GeneralSummaryReportType: 'CustomerBalanceSummary' }),
      ),
    );
    const sum = cb.filter((r) => r.kind === 'DataRow').reduce((s, r) => s + amount(r), 0);
    expect(amount(cb.find((r) => r.kind === 'TotalRow'))).toBeCloseTo(sum, 2);
    ok(t.rq('GeneralSummaryReportQueryRq', { GeneralSummaryReportType: 'VendorBalanceSummary' }));
  });

  it('unsupported reports return 3250', () => {
    const rs = t.rq('GeneralSummaryReportQueryRq', {
      GeneralSummaryReportType: 'SalesByItemSummary',
    });
    expect(rs.statusCode).toBe(3250);
    expect(
      t.rq('GeneralDetailReportQueryRq', { GeneralDetailReportType: 'GeneralLedger' }).statusCode,
    ).toBe(3250);
  });

  it('reports can be batched with other requests', () => {
    const out = t.batch([
      { rq: 'GeneralSummaryReportQueryRq', body: { GeneralSummaryReportType: 'TrialBalance' } },
      { rq: 'CustomerQueryRq', body: { MaxReturned: 1 } },
      { rq: 'AgingReportQueryRq', body: { AgingReportType: 'APAgingDetail' } },
    ]);
    expect(out.map((r) => [r.name, r.requestID, r.statusCode])).toEqual([
      ['GeneralSummaryReportQueryRs', '0', 0],
      ['CustomerQueryRs', '1', 0],
      ['AgingReportQueryRs', '2', 0],
    ]);
  });
});
