import { formatAmount, formatDateTime, toNumber } from '@qbv/qbxml';

export type Json = Record<string, unknown>;

export function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Always an array: undefined -> [], single -> [single]. */
export function arr<T = unknown>(v: unknown): T[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]) as T[];
}

/** Text of a leaf value ('x' or { '#text': 'x', '@attr': ... }). */
export function text(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isObj(v) && typeof v['#text'] === 'string') return v['#text'];
  return undefined;
}

export function num(v: unknown): number | undefined {
  const t = text(v);
  return t === undefined ? undefined : toNumber(t);
}

export function bool(v: unknown): boolean | undefined {
  const t = text(v)?.trim().toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return undefined;
}

/** Round to cents (half away from zero). */
export function cents(n: number): number {
  const r = Math.round(Math.abs(n) * 100 + Number.EPSILON * 100) / 100;
  return n < 0 ? -r : r;
}

export function amt(n: number): string {
  return formatAmount(cents(n) === 0 ? 0 : cents(n));
}

export function deepClone<T>(v: T): T {
  return structuredClone(v);
}

export function lower(s: string | undefined): string {
  return (s ?? '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Dates. Dates are 'YYYY-MM-DD' strings and compare lexicographically.

const DAY = 86_400_000;

export function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Local calendar date of an instant (QuickBooks works in the machine's local time). */
export function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

export function addDays(s: string, n: number): string {
  return ymd(new Date(parseYmd(s).getTime() + n * DAY));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseYmd(to).getTime() - parseYmd(from).getTime()) / DAY);
}

export function addMonths(s: string, n: number): string {
  const d = parseYmd(s);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return ymd(target);
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "November 17, 2026" */
export function longDate(s: string): string {
  const d = parseYmd(s);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "January 1 through November 17, 2026" (QuickBooks report subtitle style). */
export function periodSubtitle(from: string | undefined, to: string): string {
  if (!from) return `All Transactions through ${longDate(to)}`;
  const f = parseYmd(from);
  const t = parseYmd(to);
  const fs =
    f.getUTCFullYear() === t.getUTCFullYear()
      ? `${MONTHS[f.getUTCMonth()]} ${f.getUTCDate()}`
      : longDate(from);
  return `${fs} through ${longDate(to)}`;
}

export interface DateRange {
  from?: string;
  to?: string;
}

/**
 * Resolve a QuickBooks date macro (ReportDateMacro / DateMacro) relative to
 * `today`. Calendar and fiscal variants are treated the same (the fiscal year
 * starts in January).
 */
export function dateMacro(macro: string, today: string): DateRange {
  const m = macro.replace('Calendar', '').replace('Fiscal', '');
  const d = parseYmd(today);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const dow = d.getUTCDay();
  const q = Math.floor(mo / 3);
  const monthStart = (yy: number, mm: number) => ymd(new Date(Date.UTC(yy, mm, 1)));
  const monthEnd = (yy: number, mm: number) => ymd(new Date(Date.UTC(yy, mm + 1, 0)));
  const weekStart = addDays(today, -dow);
  switch (m) {
    case 'All':
      return {};
    case 'Today':
      return { from: today, to: today };
    case 'Yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'ThisWeek':
      return { from: weekStart, to: addDays(weekStart, 6) };
    case 'ThisWeekToDate':
      return { from: weekStart, to: today };
    case 'LastWeek':
      return { from: addDays(weekStart, -7), to: addDays(weekStart, -1) };
    case 'LastWeekToDate':
      return { from: addDays(weekStart, -7), to: addDays(today, -7) };
    case 'NextWeek':
      return { from: addDays(weekStart, 7), to: addDays(weekStart, 13) };
    case 'ThisMonth':
      return { from: monthStart(y, mo), to: monthEnd(y, mo) };
    case 'ThisMonthToDate':
      return { from: monthStart(y, mo), to: today };
    case 'LastMonth':
      return { from: monthStart(y, mo - 1), to: monthEnd(y, mo - 1) };
    case 'LastMonthToDate':
      return { from: monthStart(y, mo - 1), to: addMonths(today, -1) };
    case 'NextMonth':
      return { from: monthStart(y, mo + 1), to: monthEnd(y, mo + 1) };
    case 'ThisQuarter':
      return { from: monthStart(y, q * 3), to: monthEnd(y, q * 3 + 2) };
    case 'ThisQuarterToDate':
      return { from: monthStart(y, q * 3), to: today };
    case 'LastQuarter':
      return { from: monthStart(y, q * 3 - 3), to: monthEnd(y, q * 3 - 1) };
    case 'LastQuarterToDate':
      return { from: monthStart(y, q * 3 - 3), to: addMonths(today, -3) };
    case 'NextQuarter':
      return { from: monthStart(y, q * 3 + 3), to: monthEnd(y, q * 3 + 5) };
    case 'ThisYear':
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'ThisYearToDate':
      return { from: `${y}-01-01`, to: today };
    case 'LastYear':
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case 'LastYearToDate':
      return { from: `${y - 1}-01-01`, to: addMonths(today, -12) };
    case 'NextYear':
      return { from: `${y + 1}-01-01`, to: `${y + 1}-12-31` };
    default:
      return { from: `${y}-01-01`, to: today };
  }
}

// ---------------------------------------------------------------------------
// Clock

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** QuickBooks DATETIMETYPE in local time with offset, second precision. */
export function qbDateTime(d: Date): string {
  return formatDateTime(new Date(Math.floor(d.getTime() / 1000) * 1000));
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}
