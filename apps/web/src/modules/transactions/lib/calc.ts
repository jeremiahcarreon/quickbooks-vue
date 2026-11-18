/**
 * Client-side line and total arithmetic (display only; QuickBooks computes
 * the authoritative figures when it records the transaction).
 */
import {
  add,
  dec,
  div,
  fmtAmount,
  fmtPrice,
  mul,
  parseDec,
  round,
  sum,
  ZERO,
  type Dec,
} from './decimal';
import type { LineSection, RefValue, TxnLine, TxnSpec } from './types';

/** True when a line has nothing worth sending. */
export function isBlankLine(section: LineSection, line: TxnLine): boolean {
  const v = line.values;
  const has = (k: string) => {
    const x = v[k];
    if (x === undefined || x === null || x === '') return false;
    if (typeof x === 'object') {
      const r = x as RefValue;
      return !!(r.ListID || r.FullName);
    }
    return true;
  };
  if (has(section.keyColumn)) return false;
  if (has('Desc') || has('Memo')) return false;
  const amount = parseDec(v.Amount);
  if (amount !== null && amount !== ZERO) return false;
  if (section.pricing && parseDec(v[section.pricing.rate]) !== null) return false;
  return true;
}

/**
 * Line amount as QuickBooks would compute it:
 * - the typed amount when the user last edited the amount, or there is no rate;
 * - otherwise quantity x rate (a blank quantity counts as 1), rounded to cents.
 */
export function lineAmount(section: LineSection, line: TxnLine): Dec {
  const v = line.values;
  const typed = parseDec(v.Amount);
  if (!section.pricing) return typed === null ? ZERO : round(typed, 2);
  const rate = parseDec(v[section.pricing.rate]);
  if (line.lastEdited === 'amount' && typed !== null) return round(typed, 2);
  if (rate === null) return typed === null ? ZERO : round(typed, 2);
  const qty = parseDec(v[section.pricing.qty]);
  return round(mul(qty ?? dec('1'), rate), 2);
}

/** Header Quantity x Rate = Amount (Statement Charge). */
export function headerAmount(
  pricing: NonNullable<TxnSpec['headerPricing']>,
  header: Record<string, unknown>,
  lastEdited?: 'rate' | 'amount',
): Dec {
  return lineAmount(
    { key: 'h', label: '', add: '', mod: '', ret: '', columns: [], keyColumn: '', pricing },
    { key: 'h', values: header, lastEdited },
  );
}

/**
 * Apply an edit to a priced line and keep the three inputs consistent:
 * editing the amount with a quantity present derives the rate (5 places);
 * editing quantity or rate recomputes the amount.
 */
export function applyPricingEdit(
  pricing: NonNullable<LineSection['pricing']>,
  values: Record<string, unknown>,
  field: string,
): { values: Record<string, unknown>; lastEdited?: 'rate' | 'amount' } {
  const next = { ...values };
  if (field === pricing.amount) {
    const amt = parseDec(next[pricing.amount]);
    const qty = parseDec(next[pricing.qty]);
    if (amt !== null && qty !== null && qty !== ZERO) {
      const rate = div(amt, qty, 5);
      if (rate !== null) next[pricing.rate] = fmtPrice(rate);
    }
    return { values: next, lastEdited: 'amount' };
  }
  if (field === pricing.qty || field === pricing.rate) {
    const rate = parseDec(next[pricing.rate]);
    if (rate !== null) {
      const qty = parseDec(next[pricing.qty]);
      next[pricing.amount] = fmtAmount(round(mul(qty ?? dec('1'), rate), 2));
      return { values: next, lastEdited: 'rate' };
    }
    if (field === pricing.qty) return { values: next, lastEdited: 'amount' };
  }
  return { values: next };
}

export function sectionTotal(section: LineSection, lines: readonly TxnLine[]): Dec {
  return sum(
    lines.filter((l) => !isBlankLine(section, l)),
    (l) => lineAmount(section, l),
  );
}

function boolish(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

/**
 * Whether a sales line is taxable, from its tax code: the code's IsTaxable
 * flag when the picker supplied it, else the QuickBooks default code names
 * ("Tax" taxable, "Non" not).
 */
export function isTaxableCode(code: unknown): boolean {
  if (!code || typeof code !== 'object') return false;
  const r = code as RefValue;
  const flag = boolish(r.data?.IsTaxable);
  if (flag !== undefined) return flag;
  const name = (r.FullName ?? '').trim().toLowerCase();
  return name === 'tax';
}

/** Tax rate (percent) of the header sales tax item, when known. */
export function taxRateOf(salesTax: unknown): Dec | null {
  if (!salesTax || typeof salesTax !== 'object') return null;
  const r = salesTax as RefValue;
  return parseDec(r.data?.TaxRate);
}

export interface SalesTotals {
  subtotal: Dec;
  taxable: Dec;
  /** Null when the rate is unknown (QuickBooks will compute it). */
  tax: Dec | null;
  total: Dec;
}

export function salesTotals(
  section: LineSection,
  lines: readonly TxnLine[],
  salesTax: unknown,
): SalesTotals {
  const used = lines.filter((l) => !isBlankLine(section, l));
  const subtotal = sum(used, (l) => lineAmount(section, l));
  const taxable = sum(
    used.filter((l) => isTaxableCode(l.values.SalesTaxCodeRef)),
    (l) => lineAmount(section, l),
  );
  const rate = taxRateOf(salesTax);
  const tax =
    rate === null ? (taxable === ZERO ? ZERO : null) : round(mul(taxable, rate) / 100n, 2);
  return { subtotal, taxable, tax, total: add(subtotal, tax ?? ZERO) };
}

export interface PurchaseTotals {
  bySection: Record<string, Dec>;
  total: Dec;
}

export function purchaseTotals(
  sections: readonly LineSection[],
  lines: Record<string, readonly TxnLine[]>,
): PurchaseTotals {
  const bySection: Record<string, Dec> = {};
  for (const s of sections) bySection[s.key] = sectionTotal(s, lines[s.key] ?? []);
  return { bySection, total: add(...Object.values(bySection)) };
}

// ---------------------------------------------------------------------------
// Dates and terms

export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Due date from terms. StandardTerms: txn date + StdDueDays. DateDrivenTerms:
 * DayOfMonthDue of this month, moved to next month when the transaction falls
 * on/after that day or within DueNextMonthDays of it.
 */
export function dueDateFromTerms(terms: unknown, txnDate: string): string | null {
  if (!terms || typeof terms !== 'object') return null;
  const data = (terms as RefValue).data;
  const date = parseIsoDate(txnDate);
  if (!data || !date) return null;
  const n = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));
  const std = n(data.StdDueDays);
  if (std !== null && Number.isFinite(std)) {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + std);
    return isoOf(d);
  }
  const dom = n(data.DayOfMonthDue);
  if (dom !== null && Number.isFinite(dom) && dom >= 1) {
    const within = n(data.DueNextMonthDays) ?? 0;
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const clamp = (yy: number, mm: number) => {
      const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
      return new Date(Date.UTC(yy, mm, Math.min(dom, last)));
    };
    let due = clamp(y, m);
    const days = Math.round((due.getTime() - date.getTime()) / 86_400_000);
    if (days <= 0 || days < within) due = clamp(y, m + 1);
    return isoOf(due);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Item defaults

function first(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v !== '') return v;
  return undefined;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Description, price and tax code an item suggests for a sales or purchase line. */
export function itemDefaults(
  item: RefValue | null | undefined,
  side: 'sales' | 'purchase',
): { desc?: string; price?: string; taxCode?: RefValue } {
  const d = item?.data;
  if (!d) return {};
  const sop = obj(d.SalesOrPurchase);
  const sap = obj(d.SalesAndPurchase);
  const taxRef = obj(d.SalesTaxCodeRef);
  const taxCode =
    side === 'sales' && (taxRef.ListID || taxRef.FullName)
      ? {
          ...(typeof taxRef.ListID === 'string' ? { ListID: taxRef.ListID } : {}),
          ...(typeof taxRef.FullName === 'string' ? { FullName: taxRef.FullName } : {}),
        }
      : undefined;
  if (side === 'sales') {
    return {
      desc: first(d.SalesDesc, sap.SalesDesc, sop.Desc, d.ItemDesc, d.Desc),
      price: first(d.SalesPrice, sap.SalesPrice, sop.Price, d.DiscountRate),
      taxCode,
    };
  }
  return {
    desc: first(d.PurchaseDesc, sap.PurchaseDesc, sop.Desc, d.ItemDesc, d.Desc),
    price: first(d.PurchaseCost, sap.PurchaseCost, sop.Price),
  };
}

let lineSeq = 0;
export function newLineKey(): string {
  lineSeq += 1;
  return `l${Date.now().toString(36)}${lineSeq}`;
}

export function blankLine(): TxnLine {
  return { key: newLineKey(), values: {} };
}
