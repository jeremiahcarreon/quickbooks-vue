/**
 * Date helpers on plain `YYYY-MM-DD` strings (no time zones involved), and
 * resolution of QuickBooks ReportDateMacro values to a from/to range so SQL
 * reports accept the same presets QuickBooks does. Weeks start on Sunday and
 * years are calendar years (QuickBooks may use the company fiscal year for
 * its own reports).
 */

export const DATE_MACROS = [
  'All',
  'Today',
  'ThisWeek',
  'ThisWeekToDate',
  'ThisMonth',
  'ThisMonthToDate',
  'ThisQuarter',
  'ThisQuarterToDate',
  'ThisYear',
  'ThisYearToDate',
  'Yesterday',
  'LastWeek',
  'LastWeekToDate',
  'LastMonth',
  'LastMonthToDate',
  'LastQuarter',
  'LastQuarterToDate',
  'LastYear',
  'LastYearToDate',
  'NextWeek',
  'NextFourWeeks',
  'NextMonth',
  'NextQuarter',
  'NextYear',
] as const;
export type DateMacro = (typeof DATE_MACROS)[number];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return (
    d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!
  );
}

function parts(s: string): [number, number, number] {
  const m = DATE_RE.exec(s);
  if (!m) throw new RangeError(`Not a YYYY-MM-DD date: ${s}`);
  return [+m[1]!, +m[2]!, +m[3]!];
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

/** Today's date in local time as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  return fmt(utc(y, m, d + days));
}

/** Add months, clamping the day to the target month's length. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = parts(date);
  const first = utc(y, m + months, 1);
  const last = utc(first.getUTCFullYear(), first.getUTCMonth() + 2, 0).getUTCDate();
  return fmt(utc(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(d, last)));
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = parts(a);
  const [y2, m2, d2] = parts(b);
  return Math.round((utc(y2, m2, d2).getTime() - utc(y1, m1, d1).getTime()) / 86_400_000);
}

function startOfWeek(date: string): string {
  const [y, m, d] = parts(date);
  return addDays(date, -utc(y, m, d).getUTCDay());
}
function startOfMonth(date: string): string {
  const [y, m] = parts(date);
  return fmt(utc(y, m, 1));
}
function endOfMonth(date: string): string {
  const [y, m] = parts(date);
  return fmt(utc(y, m + 1, 0));
}
function startOfQuarter(date: string): string {
  const [y, m] = parts(date);
  return fmt(utc(y, Math.floor((m - 1) / 3) * 3 + 1, 1));
}
function endOfQuarter(date: string): string {
  return addDays(addMonths(startOfQuarter(date), 3), -1);
}
function startOfYear(date: string): string {
  return `${parts(date)[0]}-01-01`;
}
function endOfYear(date: string): string {
  return `${parts(date)[0]}-12-31`;
}

export interface DateRange {
  from?: string;
  to?: string;
}

/** Resolve a ReportDateMacro to an inclusive range relative to `today`. `All` has no bounds. */
export function resolveDateMacro(macro: DateMacro, today: string = todayIso()): DateRange {
  switch (macro) {
    case 'All':
      return {};
    case 'Today':
      return { from: today, to: today };
    case 'Yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'ThisWeek':
      return { from: startOfWeek(today), to: addDays(startOfWeek(today), 6) };
    case 'ThisWeekToDate':
      return { from: startOfWeek(today), to: today };
    case 'ThisMonth':
      return { from: startOfMonth(today), to: endOfMonth(today) };
    case 'ThisMonthToDate':
      return { from: startOfMonth(today), to: today };
    case 'ThisQuarter':
      return { from: startOfQuarter(today), to: endOfQuarter(today) };
    case 'ThisQuarterToDate':
      return { from: startOfQuarter(today), to: today };
    case 'ThisYear':
      return { from: startOfYear(today), to: endOfYear(today) };
    case 'ThisYearToDate':
      return { from: startOfYear(today), to: today };
    case 'LastWeek': {
      const s = addDays(startOfWeek(today), -7);
      return { from: s, to: addDays(s, 6) };
    }
    case 'LastWeekToDate':
      return { from: addDays(startOfWeek(today), -7), to: addDays(today, -7) };
    case 'LastMonth': {
      const s = addMonths(startOfMonth(today), -1);
      return { from: s, to: endOfMonth(s) };
    }
    case 'LastMonthToDate':
      return { from: addMonths(startOfMonth(today), -1), to: addMonths(today, -1) };
    case 'LastQuarter': {
      const s = addMonths(startOfQuarter(today), -3);
      return { from: s, to: endOfQuarter(s) };
    }
    case 'LastQuarterToDate':
      return { from: addMonths(startOfQuarter(today), -3), to: addMonths(today, -3) };
    case 'LastYear': {
      const s = addMonths(startOfYear(today), -12);
      return { from: s, to: endOfYear(s) };
    }
    case 'LastYearToDate':
      return { from: addMonths(startOfYear(today), -12), to: addMonths(today, -12) };
    case 'NextWeek': {
      const s = addDays(startOfWeek(today), 7);
      return { from: s, to: addDays(s, 6) };
    }
    case 'NextFourWeeks':
      return { from: addDays(today, 1), to: addDays(today, 28) };
    case 'NextMonth': {
      const s = addMonths(startOfMonth(today), 1);
      return { from: s, to: endOfMonth(s) };
    }
    case 'NextQuarter': {
      const s = addMonths(startOfQuarter(today), 3);
      return { from: s, to: endOfQuarter(s) };
    }
    case 'NextYear': {
      const s = addMonths(startOfYear(today), 12);
      return { from: s, to: endOfYear(s) };
    }
  }
}
