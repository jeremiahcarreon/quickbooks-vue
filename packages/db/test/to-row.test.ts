import { describe, expect, it } from 'vitest';
import { addDecimals, RowExtractionError, toRow } from '../src/to-row.js';

const customer = { name: 'Customer', category: 'list', idField: 'ListID' } as const;
const invoice = { name: 'Invoice', category: 'txn', idField: 'TxnID' } as const;

describe('toRow', () => {
  it('extracts list columns', () => {
    const ret = {
      ListID: '80000001-1700000000',
      TimeCreated: '2024-01-15T10:30:00-08:00',
      TimeModified: '2024-02-01T09:00:00-08:00',
      EditSequence: '1706806800',
      Name: 'Job 1',
      FullName: 'Smith Co:Job 1',
      IsActive: 'false',
      TotalBalance: '125.50',
      Balance: '100.00',
    };
    const row = toRow(customer, ret, { syncedAt: new Date('2024-03-01T00:00:00Z') });
    expect(row).toMatchObject({
      type: 'Customer',
      qb_id: '80000001-1700000000',
      edit_sequence: '1706806800',
      name: 'Smith Co:Job 1',
      is_active: false,
      amount: '125.50',
      time_created: '2024-01-15T10:30:00-08:00',
      txn_date: null,
      entity_ref_id: null,
    });
    expect(row.data).toBe(ret);
  });

  it('extracts transaction columns and sums invoice subtotal + tax exactly', () => {
    const row = toRow(invoice, {
      TxnID: '1A-1700000000',
      EditSequence: '7',
      TxnDate: '2024-02-03',
      RefNumber: 'INV-1001',
      CustomerRef: { ListID: '80000001-1700000000', FullName: 'Smith Co' },
      Subtotal: '0.10',
      SalesTaxTotal: '0.20',
      InvoiceLineRet: [{ Desc: 'x' }],
    });
    expect(row).toMatchObject({
      qb_id: '1A-1700000000',
      ref_number: 'INV-1001',
      txn_date: '2024-02-03',
      entity_ref_id: '80000001-1700000000',
      name: 'Smith Co',
      amount: '0.30',
      is_active: null,
    });
  });

  it('prefers TotalAmount, handles refs parsed as arrays and payee refs', () => {
    const row = toRow(
      { name: 'Check', idField: 'TxnID' },
      {
        TxnID: 'C1',
        Amount: '-5',
        PayeeEntityRef: [{ ListID: 'V1', FullName: 'Acme' }],
      },
    );
    expect(row.amount).toBe('-5');
    expect(row.entity_ref_id).toBe('V1');
    expect(row.name).toBe('Acme');
  });

  it('ignores malformed dates and amounts', () => {
    const row = toRow(invoice, {
      TxnID: 'T',
      TxnDate: '02/03/2024',
      TotalAmount: 'abc',
      TimeModified: 'nope',
    });
    expect(row.txn_date).toBeNull();
    expect(row.amount).toBeNull();
    expect(row.time_modified).toBeNull();
  });

  it('throws without an id, and supports id-less singletons and overrides', () => {
    expect(() => toRow(customer, { Name: 'x' })).toThrow(RowExtractionError);
    expect(toRow({ name: 'Company', idField: null }, { CompanyName: 'Acme' }).qb_id).toBe(
      'singleton',
    );
    expect(toRow({ name: 'Company', idField: null }, { CompanyName: 'Acme' }).name).toBe('Acme');
    const r = toRow(
      customer,
      { ListID: 'L', Name: 'n' },
      { overrides: { name: () => 'custom', amount: () => '9' } },
    );
    expect(r.name).toBe('custom');
    expect(r.amount).toBe('9');
  });
});

describe('addDecimals', () => {
  it.each([
    ['0.1', '0.2', '0.3'],
    ['100', '0.05', '100.05'],
    ['-1.50', '0.25', '-1.25'],
    ['-0.5', '0.25', '-0.25'],
    ['12345678901234.12345', '0.00001', '12345678901234.12346'],
  ])('%s + %s = %s', (a, b, out) => expect(addDecimals(a, b)).toBe(out));
});
