import { describe, expect, it } from 'vitest';
import { cronMatches, nextFire, parseCron, previousFire } from '../src/cron.js';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0, 0);

describe('cron', () => {
  it('parses fields, lists, ranges and steps', () => {
    const s = parseCron('*/15 1-3,22 * * 1-5');
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect([...s.hours]).toEqual([1, 2, 3, 22]);
    expect([...s.weekdays].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron('0 0 * * 7').weekdays.has(0)).toBe(true);
    expect([...parseCron('5/20 * * * *').minutes]).toEqual([5, 25, 45]);
  });

  it('rejects bad expressions', () => {
    for (const bad of [
      '',
      '* * * *',
      '60 * * * *',
      '* 24 * * *',
      '*/0 * * * *',
      'a * * * *',
      '5-1 * * * *',
    ]) {
      expect(() => parseCron(bad), bad).toThrow(/Invalid cron/);
    }
  });

  it('matches and finds the previous / next fire time for the nightly default', () => {
    const s = parseCron('0 3 * * *');
    expect(cronMatches(s, local(2026, 11, 17, 3, 0))).toBe(true);
    expect(cronMatches(s, local(2026, 11, 17, 3, 1))).toBe(false);
    expect(previousFire(s, local(2026, 11, 17, 12, 30))).toEqual(local(2026, 11, 17, 3, 0));
    expect(previousFire(s, local(2026, 11, 17, 2, 59))).toEqual(local(2026, 11, 16, 3, 0));
    expect(previousFire(s, local(2026, 11, 17, 3, 0))).toEqual(local(2026, 11, 17, 3, 0));
    expect(nextFire(s, local(2026, 11, 17, 3, 0))).toEqual(local(2026, 11, 18, 3, 0));
    expect(nextFire(s, local(2026, 11, 17, 1, 0))).toEqual(local(2026, 11, 17, 3, 0));
  });

  it('handles day-of-week and day-of-month (either matches when both are set)', () => {
    const sundays = parseCron('30 4 * * 0');
    // 2026-11-15 is a Sunday.
    expect(previousFire(sundays, local(2026, 11, 17, 0, 0))).toEqual(local(2026, 11, 15, 4, 30));
    const either = parseCron('0 0 1 * 3'); // 1st of month or Wednesdays
    expect(cronMatches(either, local(2026, 11, 1))).toBe(true); // Sunday the 1st
    expect(cronMatches(either, local(2026, 11, 18))).toBe(true); // Wednesday
    expect(cronMatches(either, local(2026, 11, 19))).toBe(false);
  });

  it('every minute', () => {
    const s = parseCron('* * * * *');
    const now = local(2026, 11, 17, 9, 41);
    expect(previousFire(s, new Date(now.getTime() + 25_000))).toEqual(now);
  });

  it('rare schedules (Feb 29)', () => {
    const s = parseCron('0 0 29 2 *');
    expect(previousFire(s, local(2026, 11, 17))).toEqual(local(2024, 2, 29));
  });
});
