import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetch } from '@/api/client';
import { paramsToQuery, runReport } from '../api';
import {
  applyPreset,
  defaultPreset,
  initialState,
  requestParams,
  toRouteQuery,
} from '../form-state';
import { csvFileName, formatCell, toCsv } from '../format';
import { detectPreset, presetRange, PRESETS } from '../presets';
import type { ReportInfo, ReportResult } from '../types';

const today = '2024-05-15'; // a Wednesday

describe('presets', () => {
  it.each([
    ['today', { from: today, to: today }],
    ['thisWeek', { from: '2024-05-12', to: '2024-05-18' }],
    ['thisMonth', { from: '2024-05-01', to: '2024-05-31' }],
    ['thisMonthToDate', { from: '2024-05-01', to: today }],
    ['thisQuarter', { from: '2024-04-01', to: '2024-06-30' }],
    ['thisQuarterToDate', { from: '2024-04-01', to: today }],
    ['thisYear', { from: '2024-01-01', to: '2024-12-31' }],
    ['ytd', { from: '2024-01-01', to: today }],
    ['lastWeek', { from: '2024-05-05', to: '2024-05-11' }],
    ['lastMonth', { from: '2024-04-01', to: '2024-04-30' }],
    ['lastQuarter', { from: '2024-01-01', to: '2024-03-31' }],
    ['lastYear', { from: '2023-01-01', to: '2023-12-31' }],
    ['lastYearToDate', { from: '2023-01-01', to: '2023-05-15' }],
    ['all', {}],
  ])('%s', (id, range) => {
    expect(presetRange(id, today)).toEqual(range);
  });

  it('handles quarter and month edges', () => {
    expect(presetRange('lastQuarter', '2024-01-10')).toEqual({
      from: '2023-10-01',
      to: '2023-12-31',
    });
    expect(presetRange('lastMonth', '2024-03-31')).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    });
    expect(presetRange('lastYearToDate', '2024-02-29')).toEqual({
      from: '2023-01-01',
      to: '2023-02-28',
    });
  });

  it('detects presets from dates', () => {
    expect(detectPreset({ from: '2024-04-01', to: '2024-06-30' }, today)).toBe('thisQuarter');
    expect(detectPreset({ from: '2024-04-02', to: '2024-06-30' }, today)).toBe('custom');
    expect(PRESETS.map((p) => p.id)).toContain('ytd');
  });
});

const sqlInfo: ReportInfo = {
  name: 'sales-by-customer-summary',
  title: 'Sales by Customer Summary',
  description: '',
  category: 'Sales',
  source: 'sql',
  params: [
    { name: 'from', label: 'From', type: 'date', group: 'period' },
    { name: 'to', label: 'To', type: 'date', group: 'period' },
    {
      name: 'dateMacro',
      label: 'Dates',
      type: 'enum',
      options: ['All', 'ThisMonthToDate'],
      default: 'ThisMonthToDate',
      group: 'period',
    },
    { name: 'name', label: 'Customer', type: 'string', group: 'filter' },
  ],
};
const qbInfo: ReportInfo = {
  name: 'GeneralDetail.GeneralLedger',
  title: 'General Ledger',
  description: '',
  category: 'Accountant & Taxes',
  source: 'qb',
  params: [
    { name: 'from', label: 'From', type: 'date', group: 'period' },
    { name: 'to', label: 'To', type: 'date', group: 'period' },
    { name: 'dateMacro', label: 'Dates', type: 'enum', options: ['All'], group: 'period' },
    { name: 'account', label: 'Accounts', type: 'multiString', group: 'filter' },
    {
      name: 'txnType',
      label: 'Types',
      type: 'multiEnum',
      options: ['Check', 'Deposit'],
      group: 'filter',
    },
    { name: 'IncludeSubcolumns', label: 'Sub', type: 'boolean', group: 'layout' },
    { name: 'FiscalYear', label: 'FY', type: 'integer', group: 'layout' },
  ],
};

describe('form state', () => {
  it('defaults the period from the report definition', () => {
    expect(defaultPreset(sqlInfo)).toBe('thisMonthToDate');
    expect(defaultPreset({ ...qbInfo, name: 'Aging.ARAgingSummary' })).toBe('today');
    expect(defaultPreset(qbInfo)).toBe('thisMonthToDate');
    const s = initialState(sqlInfo, {}, today);
    expect(s).toEqual({
      preset: 'thisMonthToDate',
      values: { name: undefined, from: '2024-05-01', to: today },
    });
  });

  it('reads params from the route query', () => {
    const s = initialState(
      qbInfo,
      {
        from: '2024-01-01',
        to: '2024-03-31',
        account: 'Checking,Savings',
        txnType: ['Check'],
        IncludeSubcolumns: 'true',
        FiscalYear: '2023',
      },
      today,
    );
    expect(s.preset).toBe('lastQuarter');
    expect(s.values).toMatchObject({
      account: ['Checking', 'Savings'],
      txnType: ['Check'],
      IncludeSubcolumns: true,
      FiscalYear: 2023,
    });
    expect(initialState(qbInfo, { dateMacro: 'LastYear' }, today).values).toMatchObject({
      from: '2023-01-01',
      to: '2023-12-31',
    });
  });

  it('builds request params; All Dates becomes dateMacro=All', () => {
    let s = initialState(sqlInfo, {}, today);
    s = applyPreset(s, 'all', today);
    expect(requestParams(sqlInfo, s)).toEqual({ dateMacro: 'All' });
    s = applyPreset(s, 'lastMonth', today);
    expect(requestParams(sqlInfo, { ...s, values: { ...s.values, name: 'acme' } })).toEqual({
      from: '2024-04-01',
      to: '2024-04-30',
      name: 'acme',
    });
    expect(applyPreset(s, 'custom', today).values.from).toBe('2024-04-01');
    expect(toRouteQuery({ a: ['x', 'y'], b: 2, c: true, d: undefined })).toEqual({
      a: 'x,y',
      b: '2',
      c: 'true',
    });
  });
});

const result: ReportResult = {
  columns: [
    { key: 'name', title: 'Customer', type: 'text' },
    { key: 'amount', title: 'Amount', type: 'amount' },
  ],
  rows: [
    { kind: 'text', indent: 0, label: 'West', cells: { name: 'West' } },
    {
      kind: 'data',
      indent: 1,
      cells: { name: 'Acme, Inc.', amount: 1234.5 },
      ref: { type: 'Customer', id: 'C1' },
    },
    { kind: 'data', indent: 1, cells: { name: '@risk', amount: -10 } },
    {
      kind: 'subtotal',
      indent: 0,
      label: 'Total West',
      cells: { name: 'Total West', amount: 1224.5 },
    },
    { kind: 'total', indent: 0, label: 'TOTAL', cells: { name: 'TOTAL', amount: 1224.5 } },
  ],
  totals: { name: 'TOTAL', amount: 1224.5 },
  meta: {
    name: 'x',
    title: 'Sales by Customer',
    subtitle: 'May 2024',
    source: 'sql',
    params: {},
    generatedAt: '2024-05-15T00:00:00Z',
    rowCount: 2,
  },
};

describe('formatting and CSV', () => {
  it('formats cells by column type', () => {
    expect(formatCell(1234.5, 'amount')).toBe('1,234.50');
    expect(formatCell(-3, 'amount')).toBe('-3.00');
    expect(formatCell(12.345, 'percent')).toBe('12.35%');
    expect(formatCell(2.123456, 'quantity')).toBe('2.12346');
    expect(formatCell(true, 'boolean')).toBe('Yes');
    expect(formatCell(null, 'amount')).toBe('');
    expect(formatCell('2024-01-01', 'date')).toBe('2024-01-01');
  });

  it('exports CSV with indentation, quoting and formula guard', () => {
    expect(toCsv(result).split('\r\n')).toEqual([
      'Sales by Customer',
      'May 2024',
      '',
      'Customer,Amount',
      'West,',
      '"  Acme, Inc.",1234.5',
      "  '@risk,-10",
      'Total West,1224.5',
      'TOTAL,1224.5',
      '',
    ]);
    expect(csvFileName(result)).toBe('Sales_by_Customer.csv');
  });
});

describe('api.runReport', () => {
  afterEach(() => setFetch((...a) => globalThis.fetch(...a)));

  it('serialises params and polls while QuickBooks is pending', async () => {
    const calls: string[] = [];
    const responses = [
      { status: 202, body: { status: 'pending', commandId: 'cmd-1', commandStatus: 'queued' } },
      { status: 202, body: { status: 'pending', commandId: 'cmd-1', commandStatus: 'sending' } },
      { status: 200, body: { status: 'ready', ...result } },
    ];
    setFetch(async (input) => {
      calls.push(String(input));
      const r = responses.shift()!;
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const pendings: string[] = [];
    const out = await runReport(
      'GeneralDetail.GeneralLedger',
      { from: '2024-01-01', account: ['A', 'B'], empty: '' },
      {
        refresh: true,
        pollMs: 1,
        onPending: (p) => pendings.push(p.commandStatus),
      },
    );
    expect(out.meta.title).toBe('Sales by Customer');
    expect('status' in out).toBe(false);
    expect(pendings).toEqual(['queued', 'sending']);
    expect(calls[0]).toBe(
      '/api/reports/GeneralDetail.GeneralLedger?from=2024-01-01&account=A&account=B&refresh=true',
    );
    expect(calls[1]).toBe(
      '/api/reports/GeneralDetail.GeneralLedger?from=2024-01-01&account=A&account=B&commandId=cmd-1',
    );
  });

  it('surfaces API errors', async () => {
    setFetch(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'qb_error', message: 'QuickBooks: feature off' } }),
          { status: 502 },
        ),
    );
    await expect(runReport('x', {})).rejects.toMatchObject({ status: 502, code: 'qb_error' });
  });

  it('drops empty params', () => {
    expect(paramsToQuery({ a: undefined, b: '', c: [], d: 'x', e: false })).toEqual({
      d: 'x',
      e: false,
    });
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      setFetch(async () => {
        vi.setSystemTime(Date.now() + 10_000);
        return new Response(
          JSON.stringify({ status: 'pending', commandId: 'c', commandStatus: 'queued' }),
          { status: 202 },
        );
      });
      await expect(runReport('x', {}, { pollMs: 1, timeoutMs: 5000 })).rejects.toMatchObject({
        code: 'timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
