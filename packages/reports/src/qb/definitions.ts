import { buildRequest, catalog, type FieldDef } from '@qbv/qbxml';
import { DATE_MACROS } from '../dates.js';
import { ReportError } from '../params.js';
import type { ParamDef, ReportDefinitionInfo, ReportParams } from '../types.js';

/** A QuickBooks report: one value of one `*ReportType` enum of one `*ReportQueryRq`. */
export interface QbReportDefinition extends ReportDefinitionInfo {
  source: 'qb';
  qb: { request: string; typeField: string; typeValue: string };
}

/** Friendly titles where splitting the enum value is not good enough. */
const TITLES: Record<string, string> = {
  '1099Detail': '1099 Detail',
  APAgingDetail: 'A/P Aging Detail',
  APAgingSummary: 'A/P Aging Summary',
  ARAgingDetail: 'A/R Aging Detail',
  ARAgingSummary: 'A/R Aging Summary',
  CollectionsReport: 'Collections Report',
  ProfitAndLossStandard: 'Profit & Loss Standard',
  ProfitAndLossDetail: 'Profit & Loss Detail',
  ProfitAndLossByClass: 'Profit & Loss by Class',
  ProfitAndLossByJob: 'Profit & Loss by Job',
  ProfitAndLossPrevYearComp: 'Profit & Loss Previous Year Comparison',
  ProfitAndLossYTDComp: 'Profit & Loss YTD Comparison',
  ProfitAndLossBudgetOverview: 'Profit & Loss Budget Overview',
  ProfitAndLossBudgetPerformance: 'Profit & Loss Budget Performance',
  ProfitAndLossBudgetVsActual: 'Profit & Loss Budget vs. Actual',
  BalanceSheetPrevYearComp: 'Balance Sheet Previous Year Comparison',
  BalanceSheetBudgetVsActual: 'Balance Sheet Budget vs. Actual',
  OpenPOs: 'Open Purchase Orders',
  OpenPOsByJob: 'Open Purchase Orders by Job',
  TxnDetailByAccount: 'Transaction Detail by Account',
  TxnListByCustomer: 'Transaction List by Customer',
  TxnListByDate: 'Transaction List by Date',
  TxnListByVendor: 'Transaction List by Vendor',
  JobProgressInvoicesVsEstimates: 'Job Progress Invoices vs. Estimates',
  ItemEstimatesVsActuals: 'Item Estimates vs. Actuals',
  JobEstimatesVsActualsDetail: 'Job Estimates vs. Actuals Detail',
  JobEstimatesVsActualsSummary: 'Job Estimates vs. Actuals Summary',
  CustomTxnDetail: 'Custom Transaction Detail',
  CustomSummary: 'Custom Summary',
  EmployeeStateTaxesDetail: 'Employee State Taxes Detail',
};

const SMALL_WORDS = new Set(['And', 'By', 'Vs', 'In', 'Of', 'To']);

/** `InventoryValuationSummaryBySite` -> `Inventory Valuation Summary by Site`. */
export function humanizeReportType(value: string): string {
  if (TITLES[value]) return TITLES[value];
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ');
  return words
    .map((w, i) => {
      if (i > 0 && SMALL_WORDS.has(w)) return w === 'And' ? '&' : w.toLowerCase();
      return w;
    })
    .join(' ');
}

/** UI grouping for QB reports (by keyword). */
export function qbReportCategory(kind: string, value: string): string {
  if (kind === 'Budget') return 'Budgets';
  if (kind === 'Payroll') return 'Payroll';
  if (kind === 'Time') return 'Jobs, Time & Mileage';
  if (kind === 'Job') return 'Jobs, Time & Mileage';
  if (kind === 'Custom') return 'Custom';
  if (kind === 'Aging')
    return value.startsWith('AP') ? 'Vendors & Payables' : 'Customers & Receivables';
  const v = value;
  if (/^(ProfitAndLoss|BalanceSheet|IncomeTax)|^Expense|^IncomeBy/.test(v))
    return 'Company & Financial';
  if (
    /^(TrialBalance|GeneralLedger|Journal|AuditTrail|TxnDetail|TxnList|MissingChecks|CheckDetail|DepositDetail)/.test(
      v,
    )
  )
    return 'Accountant & Taxes';
  if (/^(Inventory|PhysicalInventory|LotNumber|SerialNumber)/.test(v)) return 'Inventory';
  if (/^SalesTax/.test(v)) return 'Sales Tax';
  if (/^(Sales|OpenSalesOrder|PendingSales)/.test(v)) return 'Sales';
  if (/^(Purchase|OpenPO)/.test(v)) return 'Purchases';
  if (/^(Customer|OpenInvoices|Collections)/.test(v)) return 'Customers & Receivables';
  if (/^(Vendor|UnpaidBills|1099)/.test(v)) return 'Vendors & Payables';
  if (/^(Job|Estimates|Unbilled)/.test(v)) return 'Jobs, Time & Mileage';
  return 'Other';
}

const DEFAULT_DETAIL_COLUMNS = [
  'TxnType',
  'Date',
  'RefNumber',
  'Name',
  'Memo',
  'Account',
  'Amount',
];

/** Params handled through composite filters; the remaining simple fields map 1:1. */
const SKIP_FIELDS = new Set([
  'DisplayReport',
  'ReportPeriod',
  'ReportDateMacro',
  'ReportAccountFilter',
  'ReportEntityFilter',
  'ReportItemFilter',
  'ReportClassFilter',
  'ReportTxnTypeFilter',
  'ReportModifiedDateRangeFilter',
  'ReportModifiedDateRangeMacro',
]);

function objectFields(name: string): FieldDef[] {
  const o = catalog.objects[name];
  if (!o) throw new Error(`qbXML catalog has no object ${name}`);
  return o.fields;
}

function enumOf(objName: string, field: string): string[] {
  return objectFields(objName).find((f) => f.name === field)?.enum ?? [];
}

const LABELS: Record<string, string> = {
  ReportBasis: 'Basis',
  ReportAgingAsOf: 'Aging as of',
  ReportOpenBalanceAsOf: 'Open balance as of',
  ReportDetailLevelFilter: 'Detail level',
  ReportPostingStatusFilter: 'Posting status',
  SummarizeColumnsBy: 'Columns by',
  SummarizeRowsBy: 'Rows by',
  SummarizeBudgetColumnsBy: 'Columns by',
  SummarizeBudgetRowsBy: 'Rows by',
  IncludeColumn: 'Columns',
  IncludeSubcolumns: 'Include subcolumns',
  IncludeAccounts: 'Accounts',
  ReportCalendar: 'Calendar',
  ReturnRows: 'Rows to return',
  ReturnColumns: 'Columns to return',
  FiscalYear: 'Fiscal year',
  BudgetCriterion: 'Budget criterion',
};

/** Parameter definitions for one report request, derived from the catalog. */
export function qbParamsFor(request: string, typeField: string): ParamDef[] {
  const fields = objectFields(request);
  const has = (n: string) => fields.some((f) => f.name === n);
  const params: ParamDef[] = [];
  if (has('ReportPeriod')) {
    params.push(
      { name: 'from', label: 'From', type: 'date', group: 'period' },
      { name: 'to', label: 'To', type: 'date', group: 'period' },
    );
  }
  if (has('ReportDateMacro')) {
    params.push({
      name: 'dateMacro',
      label: 'Dates',
      type: 'enum',
      options: enumOf(request, 'ReportDateMacro'),
      group: 'period',
      help: 'QuickBooks date range; ignored when From/To are given',
    });
  }
  if (has('ReportAccountFilter')) {
    params.push(
      { name: 'account', label: 'Accounts', type: 'multiString', group: 'filter' },
      {
        name: 'accountType',
        label: 'Account type',
        type: 'enum',
        options: enumOf('ReportAccountFilter', 'AccountTypeFilter'),
        group: 'filter',
      },
    );
  }
  if (has('ReportEntityFilter')) {
    params.push(
      { name: 'entity', label: 'Names', type: 'multiString', group: 'filter' },
      {
        name: 'entityType',
        label: 'Name type',
        type: 'enum',
        options: enumOf('ReportEntityFilter', 'EntityTypeFilter'),
        group: 'filter',
      },
    );
  }
  if (has('ReportItemFilter')) {
    params.push(
      { name: 'item', label: 'Items', type: 'multiString', group: 'filter' },
      {
        name: 'itemType',
        label: 'Item type',
        type: 'enum',
        options: enumOf('ReportItemFilter', 'ItemTypeFilter'),
        group: 'filter',
      },
    );
  }
  if (has('ReportClassFilter')) {
    params.push({ name: 'class', label: 'Classes', type: 'multiString', group: 'filter' });
  }
  if (has('ReportTxnTypeFilter')) {
    params.push({
      name: 'txnType',
      label: 'Transaction types',
      type: 'multiEnum',
      options: enumOf('ReportTxnTypeFilter', 'TxnTypeFilter'),
      group: 'filter',
    });
  }
  if (has('ReportModifiedDateRangeFilter')) {
    params.push(
      { name: 'modifiedFrom', label: 'Modified from', type: 'date', group: 'filter' },
      { name: 'modifiedTo', label: 'Modified to', type: 'date', group: 'filter' },
    );
  }
  if (has('ReportModifiedDateRangeMacro')) {
    params.push({
      name: 'modifiedMacro',
      label: 'Modified',
      type: 'enum',
      options: enumOf(request, 'ReportModifiedDateRangeMacro'),
      group: 'filter',
    });
  }
  for (const f of fields) {
    if (f.name === typeField || SKIP_FIELDS.has(f.name) || f.kind !== 'simple') continue;
    const multi =
      f.maxOccurs === 'unbounded' || (typeof f.maxOccurs === 'number' && f.maxOccurs > 1);
    const base: ParamDef = {
      name: f.name,
      label: LABELS[f.name] ?? humanizeReportType(f.name),
      type:
        f.type === 'BOOLTYPE'
          ? 'boolean'
          : f.type === 'INTTYPE'
            ? 'integer'
            : f.enum
              ? multi
                ? 'multiEnum'
                : 'enum'
              : multi
                ? 'multiString'
                : 'string',
      group: 'layout',
    };
    if (f.enum) base.options = f.enum.filter((e) => e !== '');
    // Required schema fields get a default so a report always runs with no input.
    if (f.minOccurs > 0) {
      if (f.name === 'SummarizeColumnsBy') base.default = 'TotalOnly';
      else if (f.name === 'SummarizeRowsBy') base.default = 'Account';
      else if (f.name === 'IncludeColumn') base.default = DEFAULT_DETAIL_COLUMNS;
      else if (f.name === 'FiscalYear') base.help = 'Defaults to the current year';
      else base.required = true;
    }
    params.push(base);
  }
  return params;
}

function kindOf(request: string): string {
  return request.replace(/(Summary|Detail)?ReportQueryRq$/, '');
}

/** `GeneralSummaryReportQueryRq` -> `GeneralSummary`. */
export function reportKind(request: string): string {
  return request.replace(/ReportQueryRq$/, '');
}

let cached: QbReportDefinition[] | undefined;

/**
 * Every QuickBooks report the schema offers: for each `*ReportQueryRq`, one
 * definition per value of its required `*ReportType` enum. The empty value in
 * JobReportType (present in the schema) is not a report and is skipped.
 */
export function qbReportDefinitions(): QbReportDefinition[] {
  if (cached) return cached;
  const defs: QbReportDefinition[] = [];
  for (const rq of Object.keys(catalog.requests).sort()) {
    if (!/ReportQueryRq$/.test(rq)) continue;
    const typeFieldDef = objectFields(rq).find((f) => /ReportType$/.test(f.name) && f.enum);
    if (!typeFieldDef?.enum) continue;
    const kind = reportKind(rq);
    const group = kindOf(rq);
    const params = qbParamsFor(rq, typeFieldDef.name);
    for (const value of typeFieldDef.enum) {
      if (value === '') continue;
      defs.push({
        name: `${kind}.${value}`,
        title: humanizeReportType(value),
        description: `QuickBooks ${humanizeReportType(kind).toLowerCase()} report (${rq.replace(/Rq$/, '')}), fetched live from QuickBooks and cached.`,
        category: qbReportCategory(group, value),
        source: 'qb',
        params,
        qb: { request: rq, typeField: typeFieldDef.name, typeValue: value },
      });
    }
  }
  cached = defs;
  return defs;
}

/** All `*ReportType` enum values per request, including ones skipped from the catalog. */
export function qbReportTypeEnums(): { request: string; typeField: string; values: string[] }[] {
  return Object.keys(catalog.requests)
    .filter((rq) => /ReportQueryRq$/.test(rq))
    .sort()
    .flatMap((rq) => {
      const f = objectFields(rq).find((x) => /ReportType$/.test(x.name) && x.enum);
      return f?.enum ? [{ request: rq, typeField: f.name, values: f.enum }] : [];
    });
}

function names(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [];
}

/**
 * The Rq body for a report, from coerced params. Composite filters take a
 * type (`accountType`) in preference to names (`account`), mirroring the
 * xsd:choice in each filter.
 */
export function qbReportBody(
  def: QbReportDefinition,
  params: ReportParams,
  opts: { today?: string } = {},
): Record<string, unknown> {
  const { request, typeField, typeValue } = def.qb;
  const fields = new Set(objectFields(request).map((f) => f.name));
  const body: Record<string, unknown> = { [typeField]: typeValue };
  const p = params;

  if (fields.has('ReportPeriod') && (p.from || p.to)) {
    body.ReportPeriod = { FromReportDate: p.from, ToReportDate: p.to };
  } else if (fields.has('ReportDateMacro') && typeof p.dateMacro === 'string') {
    if (!(DATE_MACROS as readonly string[]).includes(p.dateMacro)) {
      throw new ReportError(400, 'invalid_params', `Unknown date macro ${p.dateMacro}`);
    }
    body.ReportDateMacro = p.dateMacro;
  }
  const listFilter = (
    el: string,
    typeEl: string | null,
    typeParam: string,
    nameParam: string,
  ): void => {
    if (!fields.has(el)) return;
    if (typeEl && typeof p[typeParam] === 'string') body[el] = { [typeEl]: p[typeParam] };
    else if (names(p[nameParam]).length) body[el] = { FullName: names(p[nameParam]) };
  };
  listFilter('ReportAccountFilter', 'AccountTypeFilter', 'accountType', 'account');
  listFilter('ReportEntityFilter', 'EntityTypeFilter', 'entityType', 'entity');
  listFilter('ReportItemFilter', 'ItemTypeFilter', 'itemType', 'item');
  listFilter('ReportClassFilter', null, '', 'class');
  if (fields.has('ReportTxnTypeFilter') && names(p.txnType).length) {
    body.ReportTxnTypeFilter = { TxnTypeFilter: names(p.txnType) };
  }
  if (fields.has('ReportModifiedDateRangeFilter') && (p.modifiedFrom || p.modifiedTo)) {
    body.ReportModifiedDateRangeFilter = {
      FromReportModifiedDate: p.modifiedFrom,
      ToReportModifiedDate: p.modifiedTo,
    };
  } else if (fields.has('ReportModifiedDateRangeMacro') && typeof p.modifiedMacro === 'string') {
    body.ReportModifiedDateRangeMacro = p.modifiedMacro;
  }
  for (const f of objectFields(request)) {
    if (f.name === typeField || SKIP_FIELDS.has(f.name) || f.kind !== 'simple') continue;
    const v = p[f.name];
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) body[f.name] = v;
  }
  if (fields.has('FiscalYear') && body.FiscalYear === undefined) {
    body.FiscalYear = Number((opts.today ?? new Date().toISOString()).slice(0, 4));
  }
  return body;
}

/**
 * Build the qbXML for a report via @qbv/qbxml (schema-ordered and validated
 * against the XSD; throws QbxmlValidationError when invalid).
 */
export function buildQbReportRequest(
  def: QbReportDefinition,
  params: ReportParams,
  opts: { requestID?: string; today?: string } = {},
): { rq: string; body: Record<string, unknown>; xml: string } {
  const body = qbReportBody(def, params, opts);
  const xml = buildRequest(def.qb.request, body, { requestID: opts.requestID ?? '1' });
  return { rq: def.qb.request, body, xml };
}
