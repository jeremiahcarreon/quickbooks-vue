import { describe, expect, it } from 'vitest';
import {
  applyPricingEdit,
  dueDateFromTerms,
  isBlankLine,
  isTaxableCode,
  itemDefaults,
  lineAmount,
  purchaseTotals,
  salesTotals,
} from '../lib/calc';
import {
  dec,
  div,
  fmt,
  fmtAmount,
  fmtMoney,
  fmtPrice,
  mul,
  normAmount,
  parseDec,
  round,
} from '../lib/decimal';
import { specBySlug } from '../lib/specs';
import type { TxnLine } from '../lib/types';
import { ref } from './fixtures';

const invoice = specBySlug('invoice')!;
const sales = invoice.lines[0]!;
const bill = specBySlug('bill')!;
const [expenses, items] = bill.lines as [(typeof bill.lines)[0], (typeof bill.lines)[0]];

const line = (values: Record<string, unknown>, lastEdited?: 'rate' | 'amount'): TxnLine => ({
  key: Math.random().toString(36),
  values,
  lastEdited,
});

describe('decimal', () => {
  it('parses user input exactly', () => {
    expect(fmtAmount(parseDec('1,234.5')!)).toBe('1234.50');
    expect(fmtAmount(parseDec('(12.00)')!)).toBe('-12.00');
    expect(fmtAmount(parseDec('$ 7')!)).toBe('7.00');
    expect(fmtAmount(parseDec('.5')!)).toBe('0.50');
    expect(parseDec('')).toBeNull();
    expect(parseDec('abc')).toBeNull();
    expect(parseDec('1.2.3')).toBeNull();
    expect(parseDec(undefined)).toBeNull();
    expect(fmtAmount(parseDec(0.1 + 0.2)!)).toBe('0.30');
  });

  it('avoids binary floating point errors', () => {
    // 0.1 + 0.2 and 1.005 * 100 are the classic float traps.
    expect(fmtAmount(dec('0.1') + dec('0.2'))).toBe('0.30');
    expect(fmtAmount(round(mul(dec('1.005'), dec('1')), 2))).toBe('1.01');
    expect(fmtAmount(round(mul(dec('3'), dec('33.33333')), 2))).toBe('100.00');
    expect(fmtAmount(round(mul(dec('2.5'), dec('19.99')), 2))).toBe('49.98');
    expect(fmtAmount(round(mul(dec('0.333'), dec('0.333')), 2))).toBe('0.11');
  });

  it('rounds half away from zero', () => {
    expect(fmtAmount(round(dec('2.345'), 2))).toBe('2.35');
    expect(fmtAmount(round(dec('-2.345'), 2))).toBe('-2.35');
    expect(fmtAmount(round(dec('2.344'), 2))).toBe('2.34');
  });

  it('divides and formats prices', () => {
    expect(fmtPrice(div(dec('100'), dec('3'), 5)!)).toBe('33.33333');
    expect(div(dec('1'), dec('0'))).toBeNull();
    expect(fmtPrice(dec('150.10'))).toBe('150.1');
    expect(fmtPrice(dec('2'))).toBe('2');
    expect(fmt(dec('-0.001'), 2)).toBe('0.00');
    expect(fmtMoney(dec('-1234567.891'))).toBe('-1,234,567.89');
    expect(normAmount('12')).toBe('12.00');
    expect(normAmount('x')).toBe('');
  });
});

describe('line amounts', () => {
  it('quantity x rate, rounded to cents', () => {
    expect(fmtAmount(lineAmount(sales, line({ Quantity: '3', Rate: '33.33333' }, 'rate')))).toBe(
      '100.00',
    );
    expect(fmtAmount(lineAmount(sales, line({ Quantity: '1.5', Rate: '10.555' }, 'rate')))).toBe(
      '15.83',
    );
  });

  it('a rate without quantity counts as one unit', () => {
    expect(fmtAmount(lineAmount(sales, line({ Rate: '75' }, 'rate')))).toBe('75.00');
  });

  it('a typed amount wins when it was edited last or there is no rate', () => {
    expect(
      fmtAmount(lineAmount(sales, line({ Quantity: '3', Rate: '10', Amount: '25' }, 'amount'))),
    ).toBe('25.00');
    expect(fmtAmount(lineAmount(sales, line({ Amount: '-12.5' })))).toBe('-12.50');
    expect(fmtAmount(lineAmount(expenses, line({ Amount: '45.1' })))).toBe('45.10');
  });

  it('editing quantity or rate recomputes the amount; editing the amount derives the rate', () => {
    const p = sales.pricing!;
    let r = applyPricingEdit(p, { Quantity: '4', Rate: '12.5' }, 'Rate');
    expect(r.values.Amount).toBe('50.00');
    expect(r.lastEdited).toBe('rate');
    r = applyPricingEdit(p, { ...r.values, Quantity: '6' }, 'Quantity');
    expect(r.values.Amount).toBe('75.00');
    r = applyPricingEdit(p, { ...r.values, Amount: '100' }, 'Amount');
    expect(r.values.Rate).toBe('16.66667');
    expect(r.lastEdited).toBe('amount');
    // Purchase item lines price by Cost.
    const c = applyPricingEdit(items.pricing!, { Quantity: '2', Cost: '9.99' }, 'Cost');
    expect(c.values.Amount).toBe('19.98');
  });

  it('blank lines are ignored', () => {
    expect(isBlankLine(sales, line({}))).toBe(true);
    expect(isBlankLine(sales, line({ Amount: '0' }))).toBe(true);
    expect(isBlankLine(sales, line({ Desc: 'note' }))).toBe(false);
    expect(isBlankLine(expenses, line({ AccountRef: ref('Rent') }))).toBe(false);
    expect(isBlankLine(expenses, line({ AccountRef: { FullName: '' } }))).toBe(true);
  });
});

describe('totals', () => {
  const tax = ref('Tax', 'T', { IsTaxable: 'true' });
  const non = ref('Non', 'N', { IsTaxable: 'false' });

  it('sales: subtotal, tax on taxable lines only, total', () => {
    const t = salesTotals(
      sales,
      [
        line({ Quantity: '2', Rate: '100', SalesTaxCodeRef: tax }, 'rate'),
        line({ Amount: '50', SalesTaxCodeRef: non }),
        line({ Quantity: '1', Rate: '19.99', SalesTaxCodeRef: { FullName: 'Tax' } }, 'rate'),
        line({}),
      ],
      ref('State', 'S', { TaxRate: '8.25' }),
    );
    expect(fmtAmount(t.subtotal)).toBe('269.99');
    expect(fmtAmount(t.taxable)).toBe('219.99');
    expect(fmtAmount(t.tax!)).toBe('18.15'); // 219.99 * 8.25% = 18.149...
    expect(fmtAmount(t.total)).toBe('288.14');
  });

  it('sales: tax is unknown (null) without a rate, zero with nothing taxable', () => {
    expect(
      salesTotals(sales, [line({ Amount: '10', SalesTaxCodeRef: tax })], ref('Group')).tax,
    ).toBeNull();
    expect(salesTotals(sales, [line({ Amount: '10', SalesTaxCodeRef: non })], undefined).tax).toBe(
      0n,
    );
  });

  it('tax codes: flag first, then QuickBooks default names', () => {
    expect(isTaxableCode(ref('Tax'))).toBe(true);
    expect(isTaxableCode(ref('Non'))).toBe(false);
    expect(isTaxableCode(ref('OOS', undefined, { IsTaxable: 'true' }))).toBe(true);
    expect(isTaxableCode(null)).toBe(false);
  });

  it('purchase: expenses + items', () => {
    const t = purchaseTotals(bill.lines, {
      expenses: [
        line({ AccountRef: ref('Rent'), Amount: '1000' }),
        line({ AccountRef: ref('Phone'), Amount: '89.99' }),
      ],
      items: [line({ ItemRef: ref('Widget'), Quantity: '3', Cost: '4.333' }, 'rate')],
    });
    expect(fmtAmount(t.bySection.expenses!)).toBe('1089.99');
    expect(fmtAmount(t.bySection.items!)).toBe('13.00');
    expect(fmtAmount(t.total)).toBe('1102.99');
  });
});

describe('terms and item defaults', () => {
  it('standard terms add days', () => {
    expect(dueDateFromTerms(ref('Net 30', 'x', { StdDueDays: '30' }), '2026-11-17')).toBe(
      '2026-12-17',
    );
    expect(dueDateFromTerms(ref('Due on receipt', 'x', { StdDueDays: '0' }), '2026-02-28')).toBe(
      '2026-02-28',
    );
  });

  it('date-driven terms use the day of month, moving to next month when close', () => {
    const t = ref('10th', 'x', { DayOfMonthDue: '10', DueNextMonthDays: '5' });
    expect(dueDateFromTerms(t, '2026-11-01')).toBe('2026-11-10');
    expect(dueDateFromTerms(t, '2026-11-07')).toBe('2026-12-10'); // within 5 days
    expect(dueDateFromTerms(t, '2026-11-15')).toBe('2026-12-10'); // past the day
    expect(dueDateFromTerms(ref('31st', 'x', { DayOfMonthDue: '31' }), '2026-02-01')).toBe(
      '2026-02-28',
    );
  });

  it('unknown terms give no date', () => {
    expect(dueDateFromTerms(ref('Net 30'), '2026-11-17')).toBeNull();
    expect(dueDateFromTerms(null, '2026-11-17')).toBeNull();
  });

  it('item defaults for sales and purchases', () => {
    const svc = ref('Consulting', 'I', {
      SalesOrPurchase: { Desc: 'Hourly consulting', Price: '150.00' },
      SalesTaxCodeRef: { FullName: 'Non' },
    });
    expect(itemDefaults(svc, 'sales')).toEqual({
      desc: 'Hourly consulting',
      price: '150.00',
      taxCode: { FullName: 'Non' },
    });
    const inv = ref('Widget', 'I', {
      SalesDesc: 'Widget',
      SalesPrice: '9.95',
      PurchaseDesc: 'Widget (vendor)',
      PurchaseCost: '4.10',
    });
    expect(itemDefaults(inv, 'purchase')).toEqual({ desc: 'Widget (vendor)', price: '4.10' });
    const both = ref('Install', 'I', {
      SalesAndPurchase: {
        SalesDesc: 'Install',
        SalesPrice: '80',
        PurchaseDesc: 'Sub',
        PurchaseCost: '50',
      },
    });
    expect(itemDefaults(both, 'sales').price).toBe('80');
    expect(itemDefaults(both, 'purchase').price).toBe('50');
    expect(itemDefaults(null, 'sales')).toEqual({});
  });
});
