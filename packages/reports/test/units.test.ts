import { describe, expect, it } from 'vitest';
import {
  addMonths,
  agingBuckets,
  bucketFor,
  coerceParams,
  DATE_MACROS,
  daysBetween,
  isIsoDate,
  reportToCsv,
  resolveDateMacro,
  ReportParamError,
  todayIso,
  type ParamDef,
  type ReportResult,
} from '../src/index.js';

describe('dates', () => {
  it('validates ISO dates strictly', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2023-02-29')).toBe(false);
    expect(isIsoDate('2024-1-01')).toBe(false);
  });

  it('adds months with clamping and counts days', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29');
    expect(daysBetween('2024-01-01', '2024-03-01')).toBe(60);
    expect(todayIso(new Date(2024, 4, 7, 23, 59))).toBe('2024-05-07');
  });

  // 2024-05-15 is a Wednesday.
  const today = '2024-05-15';
  it.each([
    ['All', {}],
    ['Today', { from: today, to: today }],
    ['Yesterday', { from: '2024-05-14', to: '2024-05-14' }],
    ['ThisWeek', { from: '2024-05-12', to: '2024-05-18' }],
    ['ThisWeekToDate', { from: '2024-05-12', to: today }],
    ['ThisMonth', { from: '2024-05-01', to: '2024-05-31' }],
    ['ThisMonthToDate', { from: '2024-05-01', to: today }],
    ['ThisQuarter', { from: '2024-04-01', to: '2024-06-30' }],
    ['ThisQuarterToDate', { from: '2024-04-01', to: today }],
    ['ThisYear', { from: '2024-01-01', to: '2024-12-31' }],
    ['ThisYearToDate', { from: '2024-01-01', to: today }],
    ['LastWeek', { from: '2024-05-05', to: '2024-05-11' }],
    ['LastWeekToDate', { from: '2024-05-05', to: '2024-05-08' }],
    ['LastMonth', { from: '2024-04-01', to: '2024-04-30' }],
    ['LastMonthToDate', { from: '2024-04-01', to: '2024-04-15' }],
    ['LastQuarter', { from: '2024-01-01', to: '2024-03-31' }],
    ['LastQuarterToDate', { from: '2024-01-01', to: '2024-02-15' }],
    ['LastYear', { from: '2023-01-01', to: '2023-12-31' }],
    ['LastYearToDate', { from: '2023-01-01', to: '2023-05-15' }],
    ['NextWeek', { from: '2024-05-19', to: '2024-05-25' }],
    ['NextFourWeeks', { from: '2024-05-16', to: '2024-06-12' }],
    ['NextMonth', { from: '2024-06-01', to: '2024-06-30' }],
    ['NextQuarter', { from: '2024-07-01', to: '2024-09-30' }],
    ['NextYear', { from: '2025-01-01', to: '2025-12-31' }],
  ] as const)('%s', (macro, range) => {
    expect(resolveDateMacro(macro, today)).toEqual(range);
  });

  it('covers every macro', () => {
    for (const m of DATE_MACROS) expect(() => resolveDateMacro(m, today)).not.toThrow();
  });
});

describe('coerceParams', () => {
  const defs: ParamDef[] = [
    { name: 'from', label: 'From', type: 'date' },
    { name: 'to', label: 'To', type: 'date' },
    { name: 'basis', label: 'Basis', type: 'enum', options: ['Accrual', 'Cash'] },
    { name: 'cols', label: 'Cols', type: 'multiEnum', options: ['A', 'B', 'C'] },
    { name: 'names', label: 'Names', type: 'multiString' },
    { name: 'flag', label: 'Flag', type: 'boolean', default: false },
    { name: 'n', label: 'N', type: 'integer', default: 30 },
    { name: 'need', label: 'Need', type: 'string', required: false },
  ];

  it('coerces strings, arrays and defaults', () => {
    expect(
      coerceParams(defs, {
        from: '2024-01-01',
        basis: 'Cash',
        cols: ['A', 'C,B'],
        names: 'x, y',
        flag: 'yes',
        n: '45',
        unknown: 'ignored',
      }),
    ).toEqual({
      from: '2024-01-01',
      basis: 'Cash',
      cols: ['A', 'C', 'B'],
      names: ['x', 'y'],
      flag: true,
      n: 45,
    });
    expect(coerceParams(defs, {})).toEqual({ flag: false, n: 30 });
  });

  it('collects every problem', () => {
    try {
      coerceParams(defs, {
        from: '2024-05-01',
        to: '2024-01-01',
        basis: 'x',
        cols: 'Z',
        flag: 'maybe',
        n: '1.5',
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ReportParamError);
      expect((e as ReportParamError).issues.map((i) => i.param).sort()).toEqual(
        ['basis', 'cols', 'flag', 'from', 'n'].sort(),
      );
      expect((e as ReportParamError).status).toBe(400);
    }
  });

  it('enforces required params', () => {
    expect(() =>
      coerceParams([{ name: 'r', label: 'R', type: 'string', required: true }], {}),
    ).toThrow(/r: is required/);
  });
});

describe('aging buckets', () => {
  it('assigns days to buckets', () => {
    const b = agingBuckets(30);
    expect(b.map((x) => x.label)).toEqual(['Current', '1 - 30', '31 - 60', '61 - 90', '> 90']);
    expect(bucketFor(-5, b).key).toBe('current');
    expect(bucketFor(0, b).key).toBe('current');
    expect(bucketFor(1, b).key).toBe('b1');
    expect(bucketFor(60, b).key).toBe('b2');
    expect(bucketFor(91, b).key).toBe('b4');
    expect(agingBuckets(15).map((x) => x.label)).toEqual([
      'Current',
      '1 - 15',
      '16 - 30',
      '31 - 45',
      '> 45',
    ]);
  });
});

describe('reportToCsv', () => {
  const result: ReportResult = {
    columns: [
      { key: 'name', title: 'Customer', type: 'text' },
      { key: 'amt', title: 'Amount, USD', type: 'amount' },
    ],
    rows: [
      { kind: 'text', indent: 0, label: 'Group "A"', cells: { name: 'Group "A"' } },
      { kind: 'data', indent: 1, cells: { name: '=HYPERLINK("x")', amt: -12.5 } },
      { kind: 'subtotal', indent: 0, label: 'Total', cells: { name: 'Total', amt: -12.5 } },
    ],
    totals: { name: 'Total', amt: -12.5 },
    meta: {
      name: 'x',
      title: 'My Report',
      subtitle: 'Jan',
      source: 'sql',
      params: {},
      generatedAt: '',
      rowCount: 1,
    },
  };

  it('quotes, indents and neutralises formulas', () => {
    const csv = reportToCsv(result);
    expect(csv.split('\r\n')).toEqual([
      'My Report',
      'Jan',
      '',
      'Customer,"Amount, USD"',
      '"Group ""A""",',
      `"  '=HYPERLINK(""x"")",-12.5`,
      'Total,-12.5',
      '',
    ]);
    expect(reportToCsv(result, { header: false }).startsWith('Customer,')).toBe(true);
  });
});
