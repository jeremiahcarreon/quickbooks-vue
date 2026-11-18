/** Typical form states shared by the tests. */
import { blankJournalLine, type JournalState } from '../lib/journal';
import type { LineSection, RefValue, TxnFormState, TxnLine, TxnSpec } from '../lib/types';

export const ref = (
  FullName: string,
  ListID?: string,
  data?: Record<string, unknown>,
): RefValue => ({
  FullName,
  ...(ListID ? { ListID } : {}),
  ...(data ? { data } : {}),
});

const REF_SAMPLES: Record<string, RefValue> = {
  Customer: ref('Acme Corp:Warehouse', '80000001-1700000000'),
  Vendor: ref('Office Supply Co', '80000002-1700000000'),
  Payee: ref('Office Supply Co', '80000002-1700000000'),
  Entity: ref('Acme Corp', '80000001-1700000000'),
  SalesItem: ref('Consulting', '80000010-1700000000'),
  PurchaseItem: ref('Widgets', '80000011-1700000000'),
  Account: ref('Office Expense', '80000020-1700000000'),
  BankAccount: ref('Checking', '80000021-1700000000'),
  CreditCardAccount: ref('Visa', '80000022-1700000000'),
  ARAccount: ref('Accounts Receivable'),
  APAccount: ref('Accounts Payable'),
  DepositAccount: ref('Checking', '80000021-1700000000'),
  Terms: ref('Net 30', '80000030-1700000000', { StdDueDays: '30' }),
  Class: ref('East', '80000040-1700000000'),
  SalesTax: ref('State Tax', '80000050-1700000000', { TaxRate: '8.25' }),
  SalesTaxCode: ref('Tax', '80000060-1700000000', { IsTaxable: 'true' }),
  PaymentMethod: ref('Check'),
  SalesRep: ref('JC'),
  ShipMethod: ref('UPS'),
  CustomerMsg: ref('Thank you for your business.'),
  Template: ref('Intuit Product Invoice'),
};

export function sampleRef(source: string): RefValue {
  return REF_SAMPLES[source] ?? ref(source);
}

/** A header filled the way a user typically fills it. */
export function sampleHeader(spec: TxnSpec): Record<string, unknown> {
  const h: Record<string, unknown> = {};
  for (const f of spec.header) {
    switch (f.kind) {
      case 'ref':
        h[f.name] = sampleRef(f.ref ?? '');
        break;
      case 'date':
        h[f.name] = '2026-11-17';
        break;
      case 'text':
      case 'textarea':
        h[f.name] = f.name === 'Memo' ? 'Memo with <angle> & "quotes"' : 'R-1001';
        break;
      case 'bool':
        h[f.name] = true;
        break;
      case 'amount':
        h[f.name] = '1,250.5';
        break;
      case 'qty':
        h[f.name] = '3';
        break;
      case 'price':
        h[f.name] = '19.99';
        break;
      case 'address':
        h[f.name] = {
          Addr1: 'Acme Corp',
          Addr2: '1 Main St',
          City: 'Springfield',
          State: 'IL',
          PostalCode: '62701',
        };
        break;
      case 'enum':
        h[f.name] = f.options?.[0] ?? '';
        break;
    }
  }
  // Statement charge: quantity x rate (amount derived by QuickBooks).
  if (spec.headerPricing) delete h[spec.headerPricing.amount];
  // Transfer between two different accounts.
  if (spec.type === 'Transfer') h.TransferToAccountRef = ref('Savings', '80000023-1700000000');
  return h;
}

export function sampleLines(section: LineSection, withIds = false): TxnLine[] {
  const base = (
    values: Record<string, unknown>,
    i: number,
    lastEdited?: 'rate' | 'amount',
  ): TxnLine => ({
    key: `${section.key}${i}`,
    ...(withIds && i < 2 ? { TxnLineID: `${section.key.toUpperCase()}-${i + 1}` } : {}),
    values,
    lastEdited,
  });
  const cols = new Set(section.columns.map((c) => c.name));
  const fill = (extra: Record<string, unknown>) => {
    const v: Record<string, unknown> = {};
    for (const c of section.columns) {
      if (c.kind === 'ref') v[c.name] = sampleRef(c.ref ?? '');
      else if (c.kind === 'enum') v[c.name] = c.options?.[1] ?? c.options?.[0];
      else if (c.kind === 'text') v[c.name] = `${c.label} text`;
    }
    return { ...v, ...extra };
  };
  if (section.pricing) {
    const p = section.pricing;
    return [
      base(fill({ [p.qty]: '2', [p.rate]: '150' }), 0, 'rate'),
      base(fill({ [p.qty]: '3', [p.amount]: '100' }), 1, 'amount'),
      base(fill({ [p.amount]: '-25.5' }), 2),
      ...(cols.has('Desc') ? [base({ Desc: 'Description-only line' }, 3)] : []),
      base({}, 4),
    ];
  }
  return [
    base(fill({ Amount: '45.10' }), 0),
    base(fill({ Amount: '1200' }), 1),
    base(fill({ Amount: '7' }), 2),
    base({}, 3),
  ];
}

export function sampleState(spec: TxnSpec, mode: 'add' | 'mod'): TxnFormState {
  const lines: Record<string, TxnLine[]> = {};
  for (const s of spec.lines) lines[s.key] = sampleLines(s, mode === 'mod');
  return {
    ...(mode === 'mod' ? { TxnID: '1A2B-1700000000', EditSequence: '1700000123' } : {}),
    header: sampleHeader(spec),
    lines,
    loadedSections: spec.lines.map((s) => s.key),
  };
}

export function journalSample(): JournalState {
  const l = (
    acct: string,
    debit: string,
    credit: string,
    extra: Partial<ReturnType<typeof blankJournalLine>> = {},
  ) => ({
    ...blankJournalLine(),
    AccountRef: ref(acct),
    debit,
    credit,
    ...extra,
  });
  return {
    TxnDate: '2026-11-17',
    RefNumber: 'JE-7',
    IsAdjustment: false,
    Memo: 'Accrual',
    lines: [
      l('Rent Expense', '1000.00', '', { Memo: 'November rent', ClassRef: ref('East') }),
      l('Utilities', '250.25', '', { EntityRef: ref('Power Co') }),
      l('Accrued Liabilities', '', '1250.25'),
      blankJournalLine(),
    ],
  };
}
