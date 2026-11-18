/**
 * Minimal 5-field cron expressions (minute hour day-of-month month
 * day-of-week) in the process's local time zone (set TZ). Supports `*`,
 * lists `a,b`, ranges `a-b`, steps `*\/n` and `a-b/n`, and day-of-week 0-7
 * (0 and 7 are Sunday). As in standard cron, when both day fields are
 * restricted a day matches if either does.
 */
export interface CronSchedule {
  source: string;
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

export class CronError extends Error {
  constructor(expr: string, why: string) {
    super(`Invalid cron expression "${expr}": ${why}`);
    this.name = 'CronError';
  }
}

function parseField(expr: string, part: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const item of part.split(',')) {
    const [range, stepText] = item.split('/');
    if (range === undefined || range === '') throw new CronError(expr, `empty item in "${part}"`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(expr, `bad step in "${item}"`);
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = stepText === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new CronError(expr, `"${item}" is outside ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSchedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(expr, 'expected 5 fields');
  const [mi, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const weekdays = parseField(expr, dow, 0, 7);
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    source: expr,
    minutes: parseField(expr, mi, 0, 59),
    hours: parseField(expr, h, 0, 23),
    days: parseField(expr, dom, 1, 31),
    months: parseField(expr, mon, 1, 12),
    weekdays,
    dayRestricted: dom !== '*',
    weekdayRestricted: dow !== '*',
  };
}

function dayMatches(s: CronSchedule, d: Date): boolean {
  if (!s.months.has(d.getMonth() + 1)) return false;
  const dom = s.days.has(d.getDate());
  const dow = s.weekdays.has(d.getDay());
  if (s.dayRestricted && s.weekdayRestricted) return dom || dow;
  if (s.dayRestricted) return dom;
  if (s.weekdayRestricted) return dow;
  return true;
}

export function cronMatches(s: CronSchedule, d: Date): boolean {
  return dayMatches(s, d) && s.hours.has(d.getHours()) && s.minutes.has(d.getMinutes());
}

/** Latest fire time at or before `at` (searching back up to ~4 years), or null. */
export function previousFire(s: CronSchedule, at: Date): Date | null {
  const d = new Date(at.getTime());
  d.setSeconds(0, 0);
  const sortedH = [...s.hours].sort((a, b) => b - a);
  const sortedM = [...s.minutes].sort((a, b) => b - a);
  for (let i = 0; i < 1500; i++) {
    if (dayMatches(s, d)) {
      for (const h of sortedH) {
        if (i === 0 && h > d.getHours()) continue;
        for (const m of sortedM) {
          if (i === 0 && h === d.getHours() && m > d.getMinutes()) continue;
          const c = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
          if (c.getTime() <= at.getTime()) return c;
        }
      }
    }
    // Previous day, last minute.
    d.setDate(d.getDate() - 1);
    d.setHours(23, 59, 0, 0);
  }
  return null;
}

/** Earliest fire time strictly after `at`, or null. */
export function nextFire(s: CronSchedule, at: Date): Date | null {
  const d = new Date(at.getTime());
  d.setSeconds(0, 0);
  const sortedH = [...s.hours].sort((a, b) => a - b);
  const sortedM = [...s.minutes].sort((a, b) => a - b);
  for (let i = 0; i < 1500; i++) {
    if (dayMatches(s, d)) {
      for (const h of sortedH) {
        if (i === 0 && h < d.getHours()) continue;
        for (const m of sortedM) {
          const c = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
          if (c.getTime() > at.getTime()) return c;
        }
      }
    }
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
  }
  return null;
}
