// Report queries computed from the mock's ledger, in QuickBooks' ReportRet
// shape: Profit & Loss, Balance Sheet, Trial Balance, customer / vendor
// balance summaries (GeneralSummaryReportQuery) and A/R / A/P aging
// (AgingReportQuery). Other report types return status 3250, as QuickBooks
// does for a feature that is not available.
import { escapeXml, type RequestDef } from '@qbv/qbxml';
import type { Engine, Outcome } from './engine.js';
import { balances, type AccountInfo } from './ledger.js';
import { cat, fullNameOf, status } from './qb.js';
import {
  amt,
  arr,
  cents,
  dateMacro,
  daysBetween,
  isObj,
  longDate,
  num,
  periodSubtitle,
  text,
  type DateRange,
  type Json,
} from './util.js';
import { type ParsedRq } from './xml.js';

export const REPORT_REQUESTS = new Set(
  Object.values(cat().requests)
    .filter((r) => (r.retElements ?? [r.retElement]).includes('ReportRet'))
    .map((r) => r.name),
);

interface Column {
  type: string;
  title: string;
  dataType: string;
}

interface Row {
  kind: 'DataRow' | 'TextRow' | 'SubtotalRow' | 'TotalRow';
  rowType?: string;
  rowValue?: string;
  /** TextRow label. */
  value?: string;
  cols: (string | undefined)[];
}

interface Report {
  title: string;
  subtitle: string;
  basis?: string;
  columns: Column[];
  rows: Row[];
}

const LABEL: Column = { type: 'Label', title: '', dataType: 'STRTYPE' };

function attr(name: string, v: string | number | undefined): string {
  return v === undefined ? '' : ` ${name}="${escapeXml(String(v))}"`;
}

function renderReport(rs: string, requestID: string | undefined, r: Report): string {
  const ind = (n: number) => '  '.repeat(n);
  const out: string[] = [];
  out.push(
    `${ind(2)}<${rs}${attr('requestID', requestID)} statusCode="0" statusSeverity="Info" statusMessage="Status OK">`,
  );
  out.push(`${ind(3)}<ReportRet>`);
  out.push(`${ind(4)}<ReportTitle>${escapeXml(r.title)}</ReportTitle>`);
  out.push(`${ind(4)}<ReportSubtitle>${escapeXml(r.subtitle)}</ReportSubtitle>`);
  if (r.basis) out.push(`${ind(4)}<ReportBasis>${r.basis}</ReportBasis>`);
  out.push(`${ind(4)}<NumRows>${r.rows.length}</NumRows>`);
  out.push(`${ind(4)}<NumColumns>${r.columns.length}</NumColumns>`);
  out.push(`${ind(4)}<NumColTitleRows>1</NumColTitleRows>`);
  r.columns.forEach((c, i) => {
    out.push(`${ind(4)}<ColDesc colID="${i + 1}" dataType="${c.dataType}">`);
    out.push(`${ind(5)}<ColTitle titleRow="1"${c.title ? attr('value', c.title) : ''} />`);
    out.push(`${ind(5)}<ColType>${c.type}</ColType>`);
    out.push(`${ind(4)}</ColDesc>`);
  });
  if (r.rows.length) {
    out.push(`${ind(4)}<ReportData>`);
    r.rows.forEach((row, i) => {
      const n = i + 1;
      if (row.kind === 'TextRow') {
        out.push(`${ind(5)}<TextRow rowNumber="${n}"${attr('value', row.value ?? '')} />`);
        return;
      }
      out.push(`${ind(5)}<${row.kind} rowNumber="${n}">`);
      if (row.rowType)
        out.push(`${ind(6)}<RowData rowType="${row.rowType}"${attr('value', row.rowValue)} />`);
      row.cols.forEach((v, ci) => {
        if (v !== undefined) out.push(`${ind(6)}<ColData colID="${ci + 1}"${attr('value', v)} />`);
      });
      out.push(`${ind(5)}</${row.kind}>`);
    });
    out.push(`${ind(4)}</ReportData>`);
  }
  out.push(`${ind(3)}</ReportRet>`);
  out.push(`${ind(2)}</${rs}>`);
  return out.join('\n');
}

function period(engine: Engine, body: Json, fallbackMacro: string): DateRange {
  if (isObj(body.ReportPeriod)) {
    const p = body.ReportPeriod;
    return { from: text(p.FromReportDate), to: text(p.ToReportDate) ?? engine.today() };
  }
  const r = dateMacro(text(body.ReportDateMacro) ?? fallbackMacro, engine.today());
  return { from: r.from, to: r.to ?? engine.today() };
}

// ---------------------------------------------------------------------------
// Financial statements

const SECTIONS_PL: { title: string; types: string[]; total: string }[] = [
  { title: 'Income', types: ['Income'], total: 'Total Income' },
  { title: 'Cost of Goods Sold', types: ['CostOfGoodsSold'], total: 'Total COGS' },
  { title: 'Expense', types: ['Expense'], total: 'Total Expense' },
  { title: 'Other Income', types: ['OtherIncome'], total: 'Total Other Income' },
  { title: 'Other Expense', types: ['OtherExpense'], total: 'Total Other Expense' },
];

function accountRows(
  accounts: AccountInfo[],
  bal: Map<string, number>,
): { rows: Row[]; total: number } {
  const rows: Row[] = [];
  let total = 0;
  for (const a of [...accounts].sort(
    (x, y) => (x.number ?? '').localeCompare(y.number ?? '') || x.name.localeCompare(y.name),
  )) {
    const v = bal.get(a.id) ?? 0;
    if (cents(v) === 0) continue;
    rows.push({ kind: 'DataRow', rowType: 'account', rowValue: a.name, cols: [a.name, amt(v)] });
    total += v;
  }
  return { rows, total: cents(total) };
}

function profitAndLoss(engine: Engine, body: Json): Report {
  const ledger = engine.derived().ledger;
  const p = period(engine, body, 'ThisYearToDate');
  const bal = balances(ledger, (x) => (!p.from || x.date >= p.from) && x.date <= p.to!);
  const accts = [...ledger.accounts.values()];
  const sec = (types: string[]) =>
    accountRows(
      accts.filter((a) => types.includes(a.type)),
      bal,
    );
  const rows: Row[] = [];
  const totals: Record<string, number> = {};
  for (const s of SECTIONS_PL) {
    const r = sec(s.types);
    totals[s.title] = r.total;
    if (s.title === 'Expense' || s.title === 'Other Income') {
      if (s.title === 'Expense')
        rows.push({
          kind: 'SubtotalRow',
          cols: ['Gross Profit', amt((totals.Income ?? 0) - (totals['Cost of Goods Sold'] ?? 0))],
        });
    }
    if (!r.rows.length) continue;
    if (s.title === 'Income')
      rows.push({ kind: 'TextRow', value: 'Ordinary Income/Expense', cols: [] });
    rows.push({ kind: 'TextRow', value: s.title, cols: [] }, ...r.rows, {
      kind: 'SubtotalRow',
      cols: [s.total, amt(r.total)],
    });
  }
  const ordinary =
    (totals.Income ?? 0) - (totals['Cost of Goods Sold'] ?? 0) - (totals.Expense ?? 0);
  const other = (totals['Other Income'] ?? 0) - (totals['Other Expense'] ?? 0);
  rows.push({ kind: 'SubtotalRow', cols: ['Net Ordinary Income', amt(ordinary)] });
  if (other) rows.push({ kind: 'SubtotalRow', cols: ['Net Other Income', amt(other)] });
  rows.push({ kind: 'TotalRow', cols: ['Net Income', amt(ordinary + other)] });
  return {
    title: 'Profit & Loss',
    subtitle: periodSubtitle(p.from, p.to!),
    basis: 'Accrual',
    columns: [LABEL, { type: 'Amount', title: 'TOTAL', dataType: 'AMTTYPE' }],
    rows,
  };
}

function netIncome(engine: Engine, from: string | undefined, to: string): number {
  const ledger = engine.derived().ledger;
  const bal = balances(ledger, (x) => (!from || x.date >= from) && x.date <= to);
  let n = 0;
  for (const [id, v] of bal) {
    const t = ledger.accounts.get(id)?.type ?? '';
    if (t === 'Income' || t === 'OtherIncome') n += v;
    if (t === 'Expense' || t === 'OtherExpense' || t === 'CostOfGoodsSold') n -= v;
  }
  return cents(n);
}

function balanceSheet(engine: Engine, body: Json): Report {
  const ledger = engine.derived().ledger;
  const p = period(engine, body, 'Today');
  const asOf = p.to!;
  const bal = balances(ledger, (x) => x.date <= asOf);
  const accts = [...ledger.accounts.values()];
  const group = (types: string[]) =>
    accountRows(
      accts.filter((a) => types.includes(a.type)),
      bal,
    );
  const rows: Row[] = [];
  const section = (title: string, types: string[], totalLabel: string): number => {
    const g = group(types);
    if (!g.rows.length) return 0;
    rows.push({ kind: 'TextRow', value: title, cols: [] }, ...g.rows, {
      kind: 'SubtotalRow',
      cols: [totalLabel, amt(g.total)],
    });
    return g.total;
  };
  rows.push({ kind: 'TextRow', value: 'ASSETS', cols: [] });
  rows.push({ kind: 'TextRow', value: 'Current Assets', cols: [] });
  const current =
    section('Checking/Savings', ['Bank'], 'Total Checking/Savings') +
    section('Accounts Receivable', ['AccountsReceivable'], 'Total Accounts Receivable') +
    section('Other Current Assets', ['OtherCurrentAsset'], 'Total Other Current Assets');
  rows.push({ kind: 'SubtotalRow', cols: ['Total Current Assets', amt(current)] });
  const fixed = section('Fixed Assets', ['FixedAsset'], 'Total Fixed Assets');
  const otherA = section('Other Assets', ['OtherAsset'], 'Total Other Assets');
  const assets = cents(current + fixed + otherA);
  rows.push({ kind: 'SubtotalRow', cols: ['TOTAL ASSETS', amt(assets)] });

  rows.push({ kind: 'TextRow', value: 'LIABILITIES & EQUITY', cols: [] });
  rows.push({ kind: 'TextRow', value: 'Liabilities', cols: [] });
  rows.push({ kind: 'TextRow', value: 'Current Liabilities', cols: [] });
  const curL =
    section('Accounts Payable', ['AccountsPayable'], 'Total Accounts Payable') +
    section('Credit Cards', ['CreditCard'], 'Total Credit Cards') +
    section(
      'Other Current Liabilities',
      ['OtherCurrentLiability'],
      'Total Other Current Liabilities',
    );
  rows.push({ kind: 'SubtotalRow', cols: ['Total Current Liabilities', amt(curL)] });
  const longL = section(
    'Long Term Liabilities',
    ['LongTermLiability'],
    'Total Long Term Liabilities',
  );
  const liabilities = cents(curL + longL);
  rows.push({ kind: 'SubtotalRow', cols: ['Total Liabilities', amt(liabilities)] });

  // Equity: equity accounts, prior-year earnings into Retained Earnings, this year's Net Income.
  const fyStart = `${asOf.slice(0, 4)}-01-01`;
  const prior = netIncome(engine, undefined, String(Number(asOf.slice(0, 4)) - 1) + '-12-31');
  const current_ = netIncome(engine, fyStart, asOf);
  const re = engine.special('RetainedEarnings');
  rows.push({ kind: 'TextRow', value: 'Equity', cols: [] });
  let equity = 0;
  let reShown = false;
  for (const a of accts
    .filter((x) => x.type === 'Equity')
    .sort((x, y) => x.name.localeCompare(y.name))) {
    let v = bal.get(a.id) ?? 0;
    if (re && a.id === re.key) {
      v += prior;
      reShown = true;
    }
    if (cents(v) === 0) continue;
    rows.push({ kind: 'DataRow', rowType: 'account', rowValue: a.name, cols: [a.name, amt(v)] });
    equity += v;
  }
  if (!reShown && cents(prior) !== 0) {
    rows.push({
      kind: 'DataRow',
      rowType: 'label',
      rowValue: 'Retained Earnings',
      cols: ['Retained Earnings', amt(prior)],
    });
    equity += prior;
  }
  rows.push({
    kind: 'DataRow',
    rowType: 'label',
    rowValue: 'Net Income',
    cols: ['Net Income', amt(current_)],
  });
  equity = cents(equity + current_);
  rows.push({ kind: 'SubtotalRow', cols: ['Total Equity', amt(equity)] });
  rows.push({ kind: 'TotalRow', cols: ['TOTAL LIABILITIES & EQUITY', amt(liabilities + equity)] });
  return {
    title: 'Balance Sheet',
    subtitle: `As of ${longDate(asOf)}`,
    basis: 'Accrual',
    columns: [LABEL, { type: 'Amount', title: 'TOTAL', dataType: 'AMTTYPE' }],
    rows,
  };
}

function trialBalance(engine: Engine, body: Json): Report {
  const ledger = engine.derived().ledger;
  const p = period(engine, body, 'Today');
  const asOf = p.to!;
  const fyStart = `${asOf.slice(0, 4)}-01-01`;
  const pl = new Set(['Income', 'OtherIncome', 'Expense', 'OtherExpense', 'CostOfGoodsSold']);
  // Raw debit-positive sums: P&L accounts for the fiscal year, others cumulative.
  const raw = new Map<string, number>();
  for (const x of ledger.postings) {
    const t = ledger.accounts.get(x.account)?.type ?? '';
    if (x.date > asOf || (pl.has(t) && x.date < fyStart)) continue;
    raw.set(x.account, (raw.get(x.account) ?? 0) + x.amount);
  }
  // Prior-year P&L closes into Retained Earnings (credit when profitable).
  const prior = netIncome(engine, undefined, String(Number(asOf.slice(0, 4)) - 1) + '-12-31');
  const re = engine.special('RetainedEarnings');
  const reKey = re?.key ?? 'retained-earnings';
  if (cents(prior) !== 0) raw.set(reKey, (raw.get(reKey) ?? 0) - prior);
  const rows: Row[] = [];
  let dr = 0;
  let cr = 0;
  const accts = [...ledger.accounts.values()].sort(
    (x, y) => (x.number ?? '').localeCompare(y.number ?? '') || x.name.localeCompare(y.name),
  );
  const names = new Map(accts.map((a) => [a.id, a.name]));
  names.set('retained-earnings', 'Retained Earnings');
  const ids = [...accts.map((a) => a.id), ...(re ? [] : ['retained-earnings'])];
  for (const id of ids) {
    const v = cents(raw.get(id) ?? 0);
    if (v === 0) continue;
    const name = names.get(id) ?? id;
    if (v > 0) dr += v;
    else cr -= v;
    rows.push({
      kind: 'DataRow',
      rowType: 'account',
      rowValue: name,
      cols: [name, v > 0 ? amt(v) : undefined, v < 0 ? amt(-v) : undefined],
    });
  }
  rows.push({ kind: 'TotalRow', cols: ['TOTAL', amt(dr), amt(cr)] });
  return {
    title: 'Trial Balance',
    subtitle: `As of ${longDate(asOf)}`,
    basis: 'Accrual',
    columns: [
      LABEL,
      { type: 'Debit', title: 'Debit', dataType: 'AMTTYPE' },
      { type: 'Credit', title: 'Credit', dataType: 'AMTTYPE' },
    ],
    rows,
  };
}

function balanceSummary(engine: Engine, body: Json, kind: 'Customer' | 'Vendor'): Report {
  const p = period(engine, body, 'Today');
  const rows: Row[] = [];
  let total = 0;
  const d = engine.derived();
  for (const r of engine.store
    .all(kind)
    .sort((a, b) => (fullNameOf(a.ret) ?? '').localeCompare(fullNameOf(b.ret) ?? ''))) {
    const v = kind === 'Customer' ? d.customerBalance(r.key) : d.vendorBalance(r.key);
    if (cents(v) === 0) continue;
    const name = fullNameOf(r.ret) ?? r.key;
    rows.push({ kind: 'DataRow', rowType: 'name', rowValue: name, cols: [name, amt(v)] });
    total += v;
  }
  rows.push({ kind: 'TotalRow', cols: ['TOTAL', amt(total)] });
  return {
    title: `${kind} Balance Summary`,
    subtitle: `All Transactions as of ${longDate(p.to!)}`,
    basis: 'Accrual',
    columns: [LABEL, { type: 'Amount', title: 'TOTAL', dataType: 'AMTTYPE' }],
    rows,
  };
}

// ---------------------------------------------------------------------------
// Aging

interface OpenItem {
  type: string;
  date: string;
  num?: string;
  name: string;
  due: string;
  open: number;
}

/** Open A/R or A/P items as of a date (payments dated after it are not counted). */
function openItems(engine: Engine, ar: boolean, asOf: string): OpenItem[] {
  const paidBy = new Map<string, number>();
  for (const pe of ar ? ['ReceivePayment'] : ['BillPaymentCheck', 'BillPaymentCreditCard']) {
    for (const p of engine.store.all(pe)) {
      if (String(p.ret.TxnDate) > asOf) continue;
      for (const a of arr<Json>(p.ret.AppliedToTxnRet)) {
        const id = String(a.TxnID);
        paidBy.set(id, (paidBy.get(id) ?? 0) + (num(a.Amount) ?? 0) + (num(a.DiscountAmount) ?? 0));
      }
    }
  }
  const items: OpenItem[] = [];
  const add = (entity: string, totalOf: (r: Json) => number, sign: 1 | -1) => {
    for (const r of engine.store.all(entity)) {
      const date = String(r.ret.TxnDate ?? '');
      if (!date || date > asOf || r.meta.voided) continue;
      const open = cents(totalOf(r.ret) - (paidBy.get(r.key) ?? 0));
      if (open <= 0) continue;
      const party = (r.ret.CustomerRef ?? r.ret.VendorRef) as Json | undefined;
      items.push({
        type: entity,
        date,
        num: text(r.ret.RefNumber),
        name: (party && text(party.FullName)) ?? '',
        due: text(r.ret.DueDate) ?? date,
        open: sign * open,
      });
    }
  };
  if (ar) {
    add('Invoice', (r) => (num(r.Subtotal) ?? 0) + (num(r.SalesTaxTotal) ?? 0), 1);
    add('Charge', (r) => num(r.Amount) ?? 0, 1);
    add('CreditMemo', (r) => num(r.CreditRemaining) ?? 0, -1);
  } else {
    add('Bill', (r) => num(r.AmountDue) ?? 0, 1);
    add('VendorCredit', (r) => num(r.OpenAmount) ?? 0, -1);
  }
  return items.sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date));
}

const BUCKETS = ['Current', '1 - 30', '31 - 60', '61 - 90', '> 90'];

function bucketOf(days: number): number {
  if (days <= 0) return 0;
  if (days <= 30) return 1;
  if (days <= 60) return 2;
  if (days <= 90) return 3;
  return 4;
}

function agingSummary(engine: Engine, body: Json, ar: boolean): Report {
  const asOf = period(engine, body, 'Today').to!;
  const byName = new Map<string, number[]>();
  for (const it of openItems(engine, ar, asOf)) {
    const b = byName.get(it.name) ?? [0, 0, 0, 0, 0];
    b[bucketOf(daysBetween(it.due, asOf))]! += it.open;
    byName.set(it.name, b);
  }
  const rows: Row[] = [];
  const totals = [0, 0, 0, 0, 0];
  for (const [name, b] of [...byName].sort((x, y) => x[0].localeCompare(y[0]))) {
    b.forEach((v, i) => (totals[i]! += v));
    rows.push({
      kind: 'DataRow',
      rowType: 'name',
      rowValue: name,
      cols: [name, ...b.map(amt), amt(b.reduce((s, v) => s + v, 0))],
    });
  }
  rows.push({
    kind: 'TotalRow',
    cols: ['TOTAL', ...totals.map(amt), amt(totals.reduce((s, v) => s + v, 0))],
  });
  return {
    title: ar ? 'A/R Aging Summary' : 'A/P Aging Summary',
    subtitle: `As of ${longDate(asOf)}`,
    columns: [
      LABEL,
      ...BUCKETS.map((t) => ({ type: 'Amount', title: t, dataType: 'AMTTYPE' })),
      { type: 'Total', title: 'TOTAL', dataType: 'AMTTYPE' },
    ],
    rows,
  };
}

function agingDetail(engine: Engine, body: Json, ar: boolean, title?: string): Report {
  const asOf = period(engine, body, 'Today').to!;
  const items = openItems(engine, ar, asOf);
  const rows: Row[] = [];
  let grand = 0;
  for (let b = 0; b < BUCKETS.length; b++) {
    const inB = items.filter((it) => bucketOf(daysBetween(it.due, asOf)) === b);
    if (!inB.length) continue;
    const label = b === 0 ? 'Current' : `${BUCKETS[b]} days past due`;
    rows.push({ kind: 'TextRow', value: label, cols: [] });
    let sub = 0;
    for (const it of inB) {
      sub += it.open;
      rows.push({
        kind: 'DataRow',
        cols: [
          undefined,
          it.type.replace(/([a-z])([A-Z])/g, '$1 $2'),
          it.date,
          it.num,
          it.name,
          it.due,
          String(Math.max(0, daysBetween(it.due, asOf))),
          amt(it.open),
        ],
      });
    }
    grand += sub;
    rows.push({
      kind: 'SubtotalRow',
      cols: [
        `Total ${label}`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        amt(sub),
      ],
    });
  }
  rows.push({
    kind: 'TotalRow',
    cols: ['TOTAL', undefined, undefined, undefined, undefined, undefined, undefined, amt(grand)],
  });
  return {
    title: title ?? (ar ? 'A/R Aging Detail' : 'A/P Aging Detail'),
    subtitle: `As of ${longDate(asOf)}`,
    columns: [
      { type: 'Blank', title: '', dataType: 'STRTYPE' },
      { type: 'TxnType', title: 'Type', dataType: 'ENUMTYPE' },
      { type: 'Date', title: 'Date', dataType: 'DATETYPE' },
      { type: 'RefNumber', title: 'Num', dataType: 'STRTYPE' },
      { type: 'Name', title: 'Name', dataType: 'STRTYPE' },
      { type: 'DueDate', title: 'Due Date', dataType: 'DATETYPE' },
      { type: 'Aging', title: 'Aging', dataType: 'INTTYPE' },
      { type: 'OpenBalance', title: 'Open Balance', dataType: 'AMTTYPE' },
    ],
    rows,
  };
}

export function handleReport(engine: Engine, rq: ParsedRq, def: RequestDef): Outcome {
  const body = rq.body;
  let report: Report | undefined;
  if (def.name === 'GeneralSummaryReportQueryRq') {
    switch (text(body.GeneralSummaryReportType)) {
      case 'ProfitAndLossStandard':
        report = profitAndLoss(engine, body);
        break;
      case 'BalanceSheetStandard':
      case 'BalanceSheetSummary':
        report = balanceSheet(engine, body);
        break;
      case 'TrialBalance':
        report = trialBalance(engine, body);
        break;
      case 'CustomerBalanceSummary':
        report = balanceSummary(engine, body, 'Customer');
        break;
      case 'VendorBalanceSummary':
        report = balanceSummary(engine, body, 'Vendor');
        break;
    }
  } else if (def.name === 'AgingReportQueryRq') {
    switch (text(body.AgingReportType)) {
      case 'ARAgingSummary':
        report = agingSummary(engine, body, true);
        break;
      case 'APAgingSummary':
        report = agingSummary(engine, body, false);
        break;
      case 'ARAgingDetail':
        report = agingDetail(engine, body, true);
        break;
      case 'APAgingDetail':
        report = agingDetail(engine, body, false);
        break;
      case 'CollectionsReport':
        report = agingDetail(engine, body, true, 'Collections Report');
        break;
    }
  }
  if (!report) throw status.notSupported();
  return {
    kind: 'raw',
    rs: def.response,
    xml: renderReport(def.response, rq.attrs.requestID, report),
  };
}
