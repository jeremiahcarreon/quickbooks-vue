import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatBool,
  formatDate,
  formatDateTime,
  formatInt,
  formatMoney,
  formatPercent,
  formatPrice,
  formatQuantity,
  formatValue,
  QbxmlValueError,
  toBool,
  toDate,
  toDateTime,
  toNumber,
} from '../src/index.js';

describe('typed views', () => {
  it('toNumber', () => {
    expect(toNumber('1559.97')).toBe(1559.97);
    expect(toNumber('-0.50')).toBe(-0.5);
    expect(toNumber('')).toBeUndefined();
    expect(toNumber(undefined)).toBeUndefined();
    expect(toNumber('abc')).toBeUndefined();
    expect(toNumber(3)).toBe(3);
  });

  it('toBool', () => {
    expect(toBool('true')).toBe(true);
    expect(toBool('false')).toBe(false);
    expect(toBool('1')).toBe(true);
    expect(toBool('0')).toBe(false);
    expect(toBool('')).toBeUndefined();
    expect(toBool(undefined)).toBeUndefined();
  });

  it('toDate / toDateTime', () => {
    expect(toDate('2024-01-15')?.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    expect(toDate('nope')).toBeUndefined();
    expect(toDateTime('2024-03-04T11:22:33-08:00')?.toISOString()).toBe('2024-03-04T19:22:33.000Z');
    expect(toDateTime('2024-03-04T11:22:33+05:30')?.toISOString()).toBe('2024-03-04T05:52:33.000Z');
    const local = toDateTime('2024-03-04T11:22:33')!;
    expect([local.getHours(), local.getMinutes(), local.getSeconds()]).toEqual([11, 22, 33]);
    expect(toDateTime('')).toBeUndefined();
  });
});

describe('formatting', () => {
  it('formatAmount rounds exactly to two decimals', () => {
    expect(formatAmount(1)).toBe('1.00');
    expect(formatAmount(1.005)).toBe('1.01');
    expect(formatAmount(2.675)).toBe('2.68');
    expect(formatAmount(-1.005)).toBe('-1.01');
    expect(formatAmount(0.1 + 0.2)).toBe('0.30');
    expect(formatAmount('99.999')).toBe('100.00');
    expect(formatAmount('-0.001')).toBe('0.00');
    expect(formatAmount(1e-7)).toBe('0.00');
    expect(formatAmount(1234567890123)).toBe('1234567890123.00');
    expect(() => formatAmount(12345678901234)).toThrow(QbxmlValueError);
    expect(() => formatAmount('1,000')).toThrow(QbxmlValueError);
  });

  it('price, quantity, percent allow five decimals', () => {
    expect(formatPrice(19.99)).toBe('19.99');
    expect(formatPrice('1.123456')).toBe('1.12346');
    expect(formatQuantity(3)).toBe('3');
    expect(formatQuantity(2.5)).toBe('2.5');
    expect(formatPercent(7.25)).toBe('7.25');
    expect(() => formatQuantity(12345678901)).toThrow(QbxmlValueError);
  });

  it('int, bool, date, datetime', () => {
    expect(formatInt(42)).toBe('42');
    expect(() => formatInt(1.5)).toThrow(QbxmlValueError);
    expect(formatBool(true)).toBe('true');
    expect(formatBool('0')).toBe('false');
    expect(formatDate(new Date(Date.UTC(2024, 1, 29)))).toBe('2024-02-29');
    expect(formatDateTime(new Date('2024-03-04T19:22:33Z'), { utc: true })).toBe(
      '2024-03-04T19:22:33+00:00',
    );
    const s = formatDateTime(new Date('2024-03-04T19:22:33Z'));
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(toDateTime(s)?.toISOString()).toBe('2024-03-04T19:22:33.000Z');
  });

  it('formatValue dispatches on base type', () => {
    expect(formatValue('AMTTYPE', 5)).toBe('5.00');
    expect(formatValue('QUANTYPE', 5)).toBe('5');
    expect(formatValue('BOOLTYPE', false)).toBe('false');
    expect(formatValue('DATETYPE', new Date(Date.UTC(2024, 0, 1)))).toBe('2024-01-01');
    expect(formatValue('STRTYPE', 12)).toBe('12');
    expect(formatValue('STRTYPE', 'as-is 1.005')).toBe('as-is 1.005');
    expect(() => formatValue('AMTTYPE', true)).toThrow(QbxmlValueError);
  });

  it('formatMoney for display', () => {
    expect(formatMoney('1559.9')).toBe('1,559.90');
    expect(formatMoney('1559.9', { currency: 'USD' })).toBe('$1,559.90');
    expect(formatMoney('')).toBe('');
  });
});
