/**
 * Date presets for the report form. They resolve to explicit from/to dates
 * on the client, so a report's dates are visible and its cache key is
 * stable for the day. Weeks start on Sunday; years are calendar years.
 */

export interface DateRange {
  from?: string;
  to?: string;
}

export interface Preset {
  id: string;
  label: string;
  range(today: string): DateRange;
}

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
};
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

export function todayLocal(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function shift(today: string, f: (d: Date) => Date): string {
  return fmt(f(parse(today)));
}

const startOfMonth = (t: string) => shift(t, (d) => utc(d.getUTCFullYear(), d.getUTCMonth(), 1));
const endOfMonth = (t: string) => shift(t, (d) => utc(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
const addMonths = (t: string, n: number) =>
  shift(t, (d) => {
    const last = utc(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0).getUTCDate();
    return utc(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), last));
  });
const addDays = (t: string, n: number) =>
  shift(t, (d) => utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
const startOfQuarter = (t: string) =>
  shift(t, (d) => utc(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
const endOfQuarter = (t: string) => addDays(addMonths(startOfQuarter(t), 3), -1);
const startOfWeek = (t: string) => addDays(t, -parse(t).getUTCDay());
const year = (t: string) => t.slice(0, 4);

export const PRESETS: Preset[] = [
  { id: 'today', label: 'Today', range: (t) => ({ from: t, to: t }) },
  {
    id: 'thisWeek',
    label: 'This Week',
    range: (t) => ({ from: startOfWeek(t), to: addDays(startOfWeek(t), 6) }),
  },
  {
    id: 'thisMonth',
    label: 'This Month',
    range: (t) => ({ from: startOfMonth(t), to: endOfMonth(t) }),
  },
  {
    id: 'thisMonthToDate',
    label: 'This Month-to-date',
    range: (t) => ({ from: startOfMonth(t), to: t }),
  },
  {
    id: 'thisQuarter',
    label: 'This Quarter',
    range: (t) => ({ from: startOfQuarter(t), to: endOfQuarter(t) }),
  },
  {
    id: 'thisQuarterToDate',
    label: 'This Quarter-to-date',
    range: (t) => ({ from: startOfQuarter(t), to: t }),
  },
  {
    id: 'thisYear',
    label: 'This Year',
    range: (t) => ({ from: `${year(t)}-01-01`, to: `${year(t)}-12-31` }),
  },
  { id: 'ytd', label: 'Year-to-date', range: (t) => ({ from: `${year(t)}-01-01`, to: t }) },
  {
    id: 'lastWeek',
    label: 'Last Week',
    range: (t) => ({ from: addDays(startOfWeek(t), -7), to: addDays(startOfWeek(t), -1) }),
  },
  {
    id: 'lastMonth',
    label: 'Last Month',
    range: (t) => ({
      from: addMonths(startOfMonth(t), -1),
      to: endOfMonth(addMonths(startOfMonth(t), -1)),
    }),
  },
  {
    id: 'lastQuarter',
    label: 'Last Quarter',
    range: (t) => ({ from: addMonths(startOfQuarter(t), -3), to: addDays(startOfQuarter(t), -1) }),
  },
  {
    id: 'lastYear',
    label: 'Last Year',
    range: (t) => ({ from: `${Number(year(t)) - 1}-01-01`, to: `${Number(year(t)) - 1}-12-31` }),
  },
  {
    id: 'lastYearToDate',
    label: 'Last Year-to-date',
    range: (t) => ({ from: `${Number(year(t)) - 1}-01-01`, to: addMonths(t, -12) }),
  },
  { id: 'all', label: 'All Dates', range: () => ({}) },
];

export function presetRange(id: string, today: string = todayLocal()): DateRange | undefined {
  return PRESETS.find((p) => p.id === id)?.range(today);
}

/** The preset matching a from/to pair today, or 'custom'. */
export function detectPreset(range: DateRange, today: string = todayLocal()): string {
  for (const p of PRESETS) {
    const r = p.range(today);
    if ((r.from ?? '') === (range.from ?? '') && (r.to ?? '') === (range.to ?? '')) return p.id;
  }
  return 'custom';
}

/** QuickBooks ReportDateMacro values to preset ids (for SQL report defaults). */
export const MACRO_PRESETS: Record<string, string> = {
  All: 'all',
  Today: 'today',
  ThisWeek: 'thisWeek',
  ThisMonth: 'thisMonth',
  ThisMonthToDate: 'thisMonthToDate',
  ThisQuarter: 'thisQuarter',
  ThisQuarterToDate: 'thisQuarterToDate',
  ThisYear: 'thisYear',
  ThisYearToDate: 'ytd',
  LastWeek: 'lastWeek',
  LastMonth: 'lastMonth',
  LastQuarter: 'lastQuarter',
  LastYear: 'lastYear',
  LastYearToDate: 'lastYearToDate',
};
