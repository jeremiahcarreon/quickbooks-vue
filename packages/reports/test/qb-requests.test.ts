import { describe, expect, it } from 'vitest';
import { buildRequest, catalog, validate } from '@qbv/qbxml';
import {
  buildQbReportRequest,
  coerceParams,
  getReport,
  qbReportDefinitions,
  qbReportTypeEnums,
  type QbReportDefinition,
  type ReportParams,
} from '../src/index.js';

const REPORT_REQUESTS = [
  'AgingReportQueryRq',
  'BudgetSummaryReportQueryRq',
  'CustomDetailReportQueryRq',
  'CustomSummaryReportQueryRq',
  'GeneralDetailReportQueryRq',
  'GeneralSummaryReportQueryRq',
  'JobReportQueryRq',
  'PayrollDetailReportQueryRq',
  'PayrollSummaryReportQueryRq',
  'TimeReportQueryRq',
];

function expectValid(xml: string): void {
  const r = validate(xml);
  if (!r.valid)
    throw new Error(
      `XSD invalid:\n${r.errors.map((e) => `${e.line}: ${e.message}`).join('\n')}\n${xml}`,
    );
  expect(r.valid).toBe(true);
}

const enums = qbReportTypeEnums();
const everyValue = enums.flatMap((e) => e.values.map((v) => ({ ...e, value: v })));

describe('report type enumeration', () => {
  it('covers every *ReportQueryRq in the catalog', () => {
    const fromCatalog = Object.keys(catalog.requests)
      .filter((r) => /ReportQueryRq$/.test(r))
      .sort();
    expect(fromCatalog).toEqual(REPORT_REQUESTS);
    expect(enums.map((e) => e.request)).toEqual(REPORT_REQUESTS);
  });

  it('has one definition per non-empty enum value with unique names', () => {
    const defs = qbReportDefinitions();
    const expected = everyValue.filter((v) => v.value !== '');
    expect(defs).toHaveLength(expected.length);
    expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length);
    for (const v of expected) {
      const def = defs.find((d) => d.qb.request === v.request && d.qb.typeValue === v.value);
      expect(def, `${v.request} ${v.value}`).toBeDefined();
      expect(def!.name).not.toContain(':');
    }
    // The 17.0 schema offers 93 report types (plus one empty JobReportType value).
    expect(defs.length).toBe(93);
  });

  it('includes the well-known financial statements', () => {
    for (const n of [
      'GeneralSummary.ProfitAndLossStandard',
      'GeneralSummary.BalanceSheetStandard',
      'GeneralSummary.TrialBalance',
      'GeneralDetail.GeneralLedger',
      'Aging.ARAgingSummary',
      'BudgetSummary.ProfitAndLossBudgetVsActual',
      'CustomSummary.CustomSummary',
      'CustomDetail.CustomTxnDetail',
    ]) {
      expect(getReport(n)?.source, n).toBe('qb');
    }
    expect(getReport('GeneralSummary.ProfitAndLossStandard')!.title).toBe('Profit & Loss Standard');
    expect(getReport('GeneralSummary.ProfitAndLossStandard')!.category).toBe('Company & Financial');
  });
});

describe('every report type enum value builds an XSD-valid request', () => {
  it.each(
    everyValue.map((v) => [`${v.request} ${v.typeField}=${JSON.stringify(v.value)}`, v] as const),
  )('%s', (_label, v) => {
    if (v.value === '') {
      // The schema lists an empty JobReportType; it is not offered as a report,
      // but a request carrying it is still schema-valid.
      const xml = buildRequest(v.request, minimalBody(v.request, v.typeField, ''));
      expectValid(xml);
      return;
    }
    const def = qbReportDefinitions().find(
      (d) => d.qb.request === v.request && d.qb.typeValue === v.value,
    )!;
    // Defaults only (what the UI sends with an empty form).
    const params = coerceParams(def.params, {});
    const { xml, rq } = buildQbReportRequest(def, params, { today: '2024-06-15' });
    expect(rq).toBe(v.request);
    expect(xml).toContain(`<${v.typeField}>${v.value}</${v.typeField}>`);
    expectValid(xml);
    // A dated variant.
    const dated = buildQbReportRequest(
      def,
      coerceParams(def.params, { from: '2024-01-01', to: '2024-03-31' }),
      {
        today: '2024-06-15',
      },
    );
    expectValid(dated.xml);
  });
});

function minimalBody(rq: string, typeField: string, value: string): Record<string, unknown> {
  const body: Record<string, unknown> = { [typeField]: value };
  for (const f of catalog.objects[rq]!.fields) {
    if (f.minOccurs > 0 && f.name !== typeField && !f.choiceGroup) {
      body[f.name] = f.enum ? [f.enum.find((e) => e !== '')!] : f.type === 'INTTYPE' ? 2024 : 'x';
      if (f.maxOccurs === 1) body[f.name] = (body[f.name] as unknown[])[0] ?? body[f.name];
    }
  }
  return body;
}

/** A params object exercising every parameter a definition has. */
function fullParams(def: QbReportDefinition, variant: 'names' | 'types'): ReportParams {
  const p: Record<string, unknown> = {};
  for (const d of def.params) {
    switch (d.name) {
      case 'from':
        p.from = '2024-01-01';
        break;
      case 'to':
        p.to = '2024-12-31';
        break;
      case 'dateMacro':
        break; // from/to win
      case 'account':
      case 'entity':
      case 'item':
      case 'class':
        if (variant === 'names') p[d.name] = ['Alpha & Sons', 'Beta <Co>'];
        break;
      case 'accountType':
      case 'entityType':
      case 'itemType':
        if (variant === 'types') p[d.name] = d.options![1];
        break;
      case 'modifiedFrom':
        p.modifiedFrom = '2024-01-01';
        break;
      case 'modifiedTo':
        p.modifiedTo = '2024-02-01';
        break;
      case 'modifiedMacro':
        break;
      default:
        if (d.type === 'enum') p[d.name] = d.options![d.options!.length - 1];
        else if (d.type === 'multiEnum') p[d.name] = d.options!.slice(0, 3);
        else if (d.type === 'boolean') p[d.name] = 'true';
        else if (d.type === 'integer') p[d.name] = '2023';
    }
  }
  return coerceParams(def.params, p);
}

describe('requests with every parameter set are XSD-valid', () => {
  const oneEach = REPORT_REQUESTS.map((rq) =>
    qbReportDefinitions().find((d) => d.qb.request === rq)!,
  );
  it.each(
    oneEach.flatMap((d) => (['names', 'types'] as const).map((v) => [d.qb.request, v, d] as const)),
  )('%s (%s filters)', (_rq, variant, def) => {
    const { xml, body } = buildQbReportRequest(def, fullParams(def, variant), {
      today: '2024-06-15',
    });
    expectValid(xml);
    if (def.params.some((p) => p.name === 'from')) {
      expect(body.ReportPeriod).toEqual({
        FromReportDate: '2024-01-01',
        ToReportDate: '2024-12-31',
      });
    }
    if (variant === 'names' && def.params.some((p) => p.name === 'entity')) {
      expect(xml).toContain('<FullName>Alpha &amp; Sons</FullName>');
      expect(xml).toContain('<FullName>Beta &lt;Co&gt;</FullName>');
    }
  });

  it('date macros and modified-date macros are XSD-valid for every request that has them', () => {
    for (const rq of REPORT_REQUESTS) {
      const def = qbReportDefinitions().find((d) => d.qb.request === rq)!;
      const macroDef = def.params.find((p) => p.name === 'dateMacro');
      if (!macroDef) continue;
      for (const macro of macroDef.options!) {
        const raw: Record<string, unknown> = { dateMacro: macro };
        if (def.params.some((p) => p.name === 'modifiedMacro')) raw.modifiedMacro = macro;
        const { xml } = buildQbReportRequest(def, coerceParams(def.params, raw), {
          today: '2024-06-15',
        });
        expectValid(xml);
        expect(xml).toContain(`<ReportDateMacro>${macro}</ReportDateMacro>`);
      }
    }
  });

  it('fills required schema fields with defaults', () => {
    const budget = getReport('BudgetSummary.ProfitAndLossBudgetOverview') as QbReportDefinition;
    const b = buildQbReportRequest(budget, coerceParams(budget.params, {}), {
      today: '2031-02-03',
    });
    expect(b.body.FiscalYear).toBe(2031);
    const custom = getReport('CustomSummary.CustomSummary') as QbReportDefinition;
    const c = buildQbReportRequest(custom, coerceParams(custom.params, {}));
    expect(c.body.SummarizeColumnsBy).toBe('TotalOnly');
    expect(c.body.SummarizeRowsBy).toBe('Account');
    const detail = getReport('CustomDetail.CustomTxnDetail') as QbReportDefinition;
    const d = buildQbReportRequest(detail, coerceParams(detail.params, {}));
    expect(d.body.IncludeColumn).toEqual([
      'TxnType',
      'Date',
      'RefNumber',
      'Name',
      'Memo',
      'Account',
      'Amount',
    ]);
  });

  it('rejects parameters outside the schema enums before building', () => {
    const def = getReport('GeneralSummary.ProfitAndLossStandard') as QbReportDefinition;
    expect(() => coerceParams(def.params, { ReportBasis: 'Cosmic' })).toThrow(/ReportBasis/);
    expect(() => coerceParams(def.params, { from: '2024-13-01' })).toThrow(/from/);
  });
});
