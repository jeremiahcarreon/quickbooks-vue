import { describe, expect, it } from 'vitest';
import { validate } from '@qbv/qbxml';
import {
  normalizeReportRet,
  parseQbNumber,
  parseQbReportResponse,
  ReportError,
} from '../src/index.js';

const meta = {
  name: 'GeneralSummary.ProfitAndLossStandard',
  title: 'Profit & Loss Standard',
  source: 'qb' as const,
  params: {},
  generatedAt: '2024-02-01T00:00:00.000Z',
};

function wrap(rs: string): string {
  return `<?xml version="1.0" ?>\n<QBXML><QBXMLMsgsRs>${rs}</QBXMLMsgsRs></QBXML>`;
}

/** Shaped like QuickBooks output: row kinds interleaved in rowNumber order. */
const PNL = wrap(`
<GeneralSummaryReportQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <ReportRet>
    <ReportTitle>Profit &amp; Loss</ReportTitle>
    <ReportSubtitle>January 2024</ReportSubtitle>
    <ReportBasis>Accrual</ReportBasis>
    <NumRows>9</NumRows>
    <NumColumns>2</NumColumns>
    <NumColTitleRows>1</NumColTitleRows>
    <ColDesc colID="1" dataType="STRTYPE"><ColTitle titleRow="1" /><ColType>Label</ColType></ColDesc>
    <ColDesc colID="2" dataType="AMTTYPE"><ColTitle titleRow="1" value="TOTAL" /><ColType>Total</ColType></ColDesc>
    <ReportData>
      <TextRow rowNumber="1" value="Ordinary Income/Expense" />
      <TextRow rowNumber="2" value="Income" />
      <DataRow rowNumber="3">
        <RowData rowType="account" value="Consulting Income" />
        <ColData colID="1" value="Consulting Income" />
        <ColData colID="2" value="1,500.00" />
      </DataRow>
      <DataRow rowNumber="4">
        <RowData rowType="account" value="Product Sales" />
        <ColData colID="1" value="Product Sales" />
        <ColData colID="2" value="250.50" />
      </DataRow>
      <SubtotalRow rowNumber="5">
        <RowData rowType="account" value="Income" />
        <ColData colID="1" value="Total Income" />
        <ColData colID="2" value="1750.50" />
      </SubtotalRow>
      <TextRow rowNumber="6" value="Expense" />
      <DataRow rowNumber="7">
        <RowData rowType="account" value="Rent" />
        <ColData colID="1" value="Rent" />
        <ColData colID="2" value="(800.00)" />
      </DataRow>
      <SubtotalRow rowNumber="8">
        <ColData colID="1" value="Total Expense" />
        <ColData colID="2" value="-800.00" />
      </SubtotalRow>
      <SubtotalRow rowNumber="9">
        <ColData colID="1" value="Net Ordinary Income" />
        <ColData colID="2" value="950.50" />
      </SubtotalRow>
      <TotalRow rowNumber="10">
        <ColData colID="1" value="Net Income" />
        <ColData colID="2" value="950.50" />
      </TotalRow>
    </ReportData>
  </ReportRet>
</GeneralSummaryReportQueryRs>`);

const AGING = wrap(`
<AgingReportQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <ReportRet>
    <ReportTitle>A/R Aging Summary</ReportTitle>
    <ReportSubtitle>As of February 1, 2024</ReportSubtitle>
    <NumRows>2</NumRows>
    <NumColumns>4</NumColumns>
    <NumColTitleRows>2</NumColTitleRows>
    <ColDesc colID="1" dataType="STRTYPE"><ColTitle titleRow="1" /><ColTitle titleRow="2" /><ColType>Label</ColType></ColDesc>
    <ColDesc colID="2" dataType="AMTTYPE"><ColTitle titleRow="1" value="Current" /><ColTitle titleRow="2" value="" /><ColType>Amount</ColType></ColDesc>
    <ColDesc colID="3" dataType="AMTTYPE"><ColTitle titleRow="1" value="1 - 30" /><ColTitle titleRow="2" value="days" /><ColType>Amount</ColType></ColDesc>
    <ColDesc colID="4" dataType="AMTTYPE"><ColTitle titleRow="1" value="TOTAL" /><ColType>Total</ColType></ColDesc>
    <ReportData>
      <DataRow rowNumber="1">
        <RowData rowType="name" value="Acme" />
        <ColData colID="1" value="Acme" />
        <ColData colID="2" value="100.00" />
        <ColData colID="3" value="0.00" />
        <ColData colID="4" value="100.00" />
      </DataRow>
      <TotalRow rowNumber="2">
        <ColData colID="1" value="TOTAL" />
        <ColData colID="2" value="100.00" />
        <ColData colID="3" value="0.00" />
        <ColData colID="4" value="100.00" />
      </TotalRow>
    </ReportData>
  </ReportRet>
</AgingReportQueryRs>`);

const GL = wrap(`
<GeneralDetailReportQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <ReportRet>
    <ReportTitle>General Ledger</ReportTitle>
    <ReportSubtitle>January 2024</ReportSubtitle>
    <ReportBasis>Accrual</ReportBasis>
    <NumRows>4</NumRows>
    <NumColumns>5</NumColumns>
    <NumColTitleRows>1</NumColTitleRows>
    <ColDesc colID="1" dataType="STRTYPE"><ColTitle titleRow="1" /><ColType>Blank</ColType></ColDesc>
    <ColDesc colID="2" dataType="STRTYPE"><ColTitle titleRow="1" value="Type" /><ColType>TxnType</ColType></ColDesc>
    <ColDesc colID="3" dataType="DATETYPE"><ColTitle titleRow="1" value="Date" /><ColType>Date</ColType></ColDesc>
    <ColDesc colID="4" dataType="QUANTYPE"><ColTitle titleRow="1" value="Qty" /><ColType>Quantity</ColType></ColDesc>
    <ColDesc colID="5" dataType="AMTTYPE"><ColTitle titleRow="1" value="Amount" /><ColType>Amount</ColType></ColDesc>
    <ReportData>
      <TextRow rowNumber="1" value="Checking" />
      <DataRow rowNumber="2">
        <RowData rowType="account" value="Checking" />
        <ColData colID="2" value="Deposit" />
        <ColData colID="3" value="2024-01-05" />
        <ColData colID="4" value="2" />
        <ColData colID="5" value="500.00" />
      </DataRow>
      <SubtotalRow rowNumber="3">
        <ColData colID="1" value="Total Checking" />
        <ColData colID="5" value="500.00" />
      </SubtotalRow>
      <TotalRow rowNumber="4">
        <ColData colID="1" value="TOTAL" />
        <ColData colID="5" value="500.00" />
      </TotalRow>
    </ReportData>
  </ReportRet>
</GeneralDetailReportQueryRs>`);

describe('QB report responses used in these tests are XSD-valid', () => {
  it.each([
    ['P&L', PNL],
    ['aging', AGING],
    ['general ledger', GL],
  ])('%s', (_n, xml) => {
    const r = validate(xml);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });
});

describe('parseQbReportResponse', () => {
  it('normalizes a summary report: order, indents, kinds, numbers, totals', () => {
    const r = parseQbReportResponse(PNL, meta);
    expect(r.meta.title).toBe('Profit & Loss');
    expect(r.meta.subtitle).toBe('January 2024');
    expect(r.meta.basis).toBe('Accrual');
    expect(r.meta.rowCount).toBe(3);
    expect(r.columns).toEqual([
      { key: 'c1', title: '', type: 'text', qbType: 'Label' },
      { key: 'c2', title: 'TOTAL', type: 'amount', qbType: 'Total' },
    ]);
    expect(r.rows.map((x) => [x.kind, x.indent, x.label])).toEqual([
      ['text', 0, 'Ordinary Income/Expense'],
      ['text', 1, 'Income'],
      ['data', 2, 'Consulting Income'],
      ['data', 2, 'Product Sales'],
      ['subtotal', 1, 'Total Income'],
      ['text', 1, 'Expense'],
      ['data', 2, 'Rent'],
      ['subtotal', 1, 'Total Expense'],
      ['subtotal', 0, 'Net Ordinary Income'],
      ['total', 0, 'Net Income'],
    ]);
    expect(r.rows[2]!.cells.c2).toBe(1500);
    expect(r.rows[2]!.rowType).toBe('account');
    expect(r.rows[6]!.cells.c2).toBe(-800);
    expect(r.totals).toEqual({ c1: 'Net Income', c2: 950.5 });
  });

  it('joins multi-row column titles and keeps each title row', () => {
    const r = parseQbReportResponse(AGING, { ...meta, name: 'Aging.ARAgingSummary' });
    expect(r.columns.map((c) => c.title)).toEqual(['', 'Current', '1 - 30 days', 'TOTAL']);
    expect(r.columns[2]!.titles).toEqual(['1 - 30', 'days']);
    expect(r.totals?.c4).toBe(100);
  });

  it('handles detail reports with a blank label column and typed cells', () => {
    const r = parseQbReportResponse(GL, meta);
    const data = r.rows.find((x) => x.kind === 'data')!;
    expect(data.indent).toBe(1);
    expect(data.label).toBe('Deposit');
    expect(data.cells).toEqual({ c2: 'Deposit', c3: '2024-01-05', c4: 2, c5: 500 });
    expect(r.columns[3]!.type).toBe('quantity');
    expect(r.columns[2]!.type).toBe('date');
  });

  it('turns a QuickBooks error status into a ReportError', () => {
    const xml = wrap(
      `<GeneralSummaryReportQueryRs requestID="1" statusCode="3250" statusSeverity="Error" statusMessage="This feature is not enabled" />`,
    );
    expect(validate(xml).valid).toBe(true);
    try {
      parseQbReportResponse(xml, meta);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ReportError);
      expect((e as ReportError).status).toBe(502);
      expect((e as ReportError).details).toMatchObject({ statusCode: 3250 });
    }
  });

  it('returns an empty report when QuickBooks has no data', () => {
    const xml = wrap(
      `<GeneralDetailReportQueryRs requestID="1" statusCode="1" statusSeverity="Info" statusMessage="No data" />`,
    );
    expect(validate(xml).valid).toBe(true);
    const r = parseQbReportResponse(xml, meta);
    expect(r.rows).toEqual([]);
    expect(r.meta.notes).toEqual(['No data']);
  });

  it('normalizeReportRet tolerates a ReportRet without ReportData', () => {
    const r = normalizeReportRet(
      { ReportTitle: 'X', ReportSubtitle: '', NumRows: '0', NumColumns: '0', NumColTitleRows: '1' },
      meta,
    );
    expect(r.rows).toEqual([]);
    expect(r.totals).toBeNull();
  });
});

describe('parseQbNumber', () => {
  it.each([
    ['1,234.56', 1234.56],
    ['(12.50)', -12.5],
    ['-3', -3],
    ['45.5%', 45.5],
    ['.5', 0.5],
    ['', null],
    ['abc', null],
  ])('%s', (s, n) => expect(parseQbNumber(s)).toBe(n));
});
