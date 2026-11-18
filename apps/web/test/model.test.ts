import { describe, expect, it } from 'vitest';
import {
  activeFields,
  describeObject,
  fieldDiff,
  flatten,
  mapServerErrors,
  normalizeNumber,
  selectedBranch,
  validateValue,
  type ChoiceItem,
} from '@/forms/model';
import { refTargets } from '@/lib/entities';
import { ctxFor, entityNames } from './helpers/catalog';

describe('describeObject', () => {
  it('maps catalog field types to inputs', () => {
    const f = describeObject('CustomerAdd', ctxFor('Customer'));
    const by = Object.fromEntries(f.fields.map((x) => [x.name, x]));
    expect(by.Name).toMatchObject({ kind: 'text', required: true, label: 'Name' });
    expect(by.Name!.def.maxLength).toBe(41);
    expect(by.IsActive!.kind).toBe('bool');
    expect(by.BillAddress).toMatchObject({ kind: 'object', child: 'BillAddress' });
    expect(by.TermsRef).toMatchObject({
      kind: 'ref',
      refTargets: ['StandardTerms', 'DateDrivenTerms'],
    });
    expect(by.ParentRef!.refTargets).toEqual(['Customer']);
    expect(by.CreditLimit).toMatchObject({ kind: 'money', numberKind: 'amount' });
    expect(by.OpenBalanceDate!.kind).toBe('date');
    expect(by.JobStatus!.kind).toBe('enum');
    expect(by.Notes!.kind).toBe('textarea');
  });

  it('hides ids and EditSequence on Mod objects and TxnLineID on lines', () => {
    const m = describeObject('InvoiceMod', ctxFor('Invoice'));
    expect(m.fields.find((x) => x.name === 'TxnID')!.hidden).toBe(true);
    expect(m.fields.find((x) => x.name === 'EditSequence')!.hidden).toBe(true);
    const line = describeObject('InvoiceLineMod', ctxFor('Invoice'));
    expect(line.fields.find((x) => x.name === 'TxnLineID')!.hidden).toBe(true);
    // a TxnID the user types (applying a payment) stays visible
    const ap = describeObject('AppliedToTxnAdd', ctxFor('ReceivePayment'));
    expect(ap.fields.find((x) => x.name === 'TxnID')!.hidden).toBe(false);
  });

  it('builds choice groups and treats repeating line choices as any-of', () => {
    const inv = describeObject('InvoiceAdd', ctxFor('Invoice'));
    expect(inv.anyOf).toEqual([
      { id: 'c1', required: false, fields: ['InvoiceLineAdd', 'InvoiceLineGroupAdd'] },
    ]);
    const lines = inv.fields.find((x) => x.name === 'InvoiceLineAdd')!;
    expect(lines).toMatchObject({ kind: 'lines', child: 'InvoiceLineAdd', repeating: true });

    const rp = describeObject('ReceivePaymentAdd', ctxFor('ReceivePayment'));
    const choice = rp.layout.find((x) => x.type === 'choice') as ChoiceItem;
    expect(choice.required).toBe(true);
    expect(choice.branches.map((b) => b.label)).toEqual([
      'Is Auto Apply',
      'Applied To Transaction Add',
    ]);
    expect(selectedBranch(choice, {})).toBe(0);
    expect(selectedBranch(choice, { AppliedToTxnAdd: [{ TxnID: 'x' }] })).toBe(1);
    expect(selectedBranch(choice, { __choice: { c1: 1 } })).toBe(1);
    expect(activeFields(rp, { __choice: { c1: 1 } }).map((x) => x.name)).toContain(
      'AppliedToTxnAdd',
    );
    expect(activeFields(rp, { __choice: { c1: 1 } }).map((x) => x.name)).not.toContain(
      'IsAutoApply',
    );

    const line = describeObject('InvoiceLineAdd', ctxFor('Invoice'));
    const rate = line.layout.find((x) => x.type === 'choice') as ChoiceItem;
    expect(rate.required).toBe(false);
    expect(selectedBranch(rate, {})).toBe(-1);
    expect(selectedBranch(rate, { RatePercent: '5' })).toBe(1);
  });

  it('handles nested choices (JournalEntryAdd currency options)', () => {
    const je = describeObject('JournalEntryAdd', ctxFor('JournalEntry'));
    const c = je.layout.find((x) => x.type === 'choice') as ChoiceItem;
    expect(c.branches[1]!.items.map((i) => (i.type === 'field' ? i.field.name : '#'))).toEqual([
      'IsAmountsEnteredInHomeCurrency',
      'CurrencyRef',
      'ExchangeRate',
    ]);
  });
});

describe('refTargets', () => {
  it('resolves exact, suffix, union and party refs', () => {
    expect(refTargets('CustomerRef', entityNames)).toEqual(['Customer']);
    expect(refTargets('ARAccountRef', entityNames)).toEqual(['Account']);
    expect(refTargets('DepositToAccountRef', entityNames)).toEqual(['Account']);
    expect(refTargets('CustomerSalesTaxCodeRef', entityNames)).toEqual(['SalesTaxCode']);
    expect(refTargets('ItemSalesTaxRef', entityNames)).toEqual(['ItemSalesTax']);
    const items = refTargets('ItemRef', entityNames);
    expect(items).toContain('ItemService');
    expect(items).toContain('ItemInventory');
    expect(items).not.toContain('ItemSites');
    expect(refTargets('EntityRef', entityNames)).toEqual([
      'Customer',
      'Vendor',
      'Employee',
      'OtherName',
    ]);
    expect(refTargets('PayeeEntityRef', entityNames)).toEqual([
      'Customer',
      'Vendor',
      'Employee',
      'OtherName',
    ]);
    expect(refTargets('TermsRef', entityNames)).toEqual(['StandardTerms', 'DateDrivenTerms']);
    expect(refTargets('ParentRef', entityNames, 'Account')).toEqual(['Account']);
    expect(refTargets('ParentRef', entityNames, 'ItemService')).toContain('ItemInventory');
    expect(refTargets('PreferredVendorRef', entityNames)).toEqual(['Vendor']);
  });
});

describe('validateValue', () => {
  const ctx = ctxFor('Customer');
  it('reports required, maxLength, enum, number and date problems with field paths', () => {
    const errors = validateValue(
      'CustomerAdd',
      {
        Name: '',
        CompanyName: 'x'.repeat(42),
        JobStatus: 'Bogus',
        CreditLimit: '12.345',
        OpenBalanceDate: '2026-02-30',
        BillAddress: { Addr1: 'y'.repeat(42) },
      },
      ctx,
    );
    expect(errors).toEqual({
      Name: 'Required',
      CompanyName: 'At most 41 characters',
      JobStatus: 'Choose one of the listed values',
      CreditLimit: 'Enter an amount with up to 2 decimals',
      OpenBalanceDate: 'Enter a date (YYYY-MM-DD)',
      'BillAddress.Addr1': 'At most 41 characters',
    });
  });

  it('validates line rows with indexed paths and skips empty rows', () => {
    const errors = validateValue(
      'InvoiceAdd',
      {
        CustomerRef: { FullName: 'Acme' },
        InvoiceLineAdd: [{}, { Quantity: 'abc' }, { Rate: '1.123456' }],
      },
      ctxFor('Invoice'),
    );
    expect(errors).toEqual({
      'InvoiceLineAdd[1].Quantity': 'Enter a number with up to 5 decimals',
      'InvoiceLineAdd[2].Rate': 'Enter a number with up to 5 decimals',
    });
  });
});

describe('normalizeNumber', () => {
  it('pads AMTTYPE to two decimals and strips separators', () => {
    expect(normalizeNumber('12.5', 'amount')).toBe('12.50');
    expect(normalizeNumber('1,234', 'amount')).toBe('1234');
    expect(normalizeNumber('.5', 'amount')).toBe('0.50');
    expect(normalizeNumber('-3.', 'price')).toBe('-3');
    expect(normalizeNumber('2.12345', 'quantity')).toBe('2.12345');
    expect(normalizeNumber('abc', 'amount')).toBe('abc');
  });
});

describe('mapServerErrors', () => {
  const form = describeObject('CustomerAdd', ctxFor('Customer'));
  it('maps zod-style paths, XPath paths and libxml2 messages onto fields', () => {
    const res = mapServerErrors(
      [
        { path: ['body', 'Name'], message: 'Too long' },
        {
          path: '/QBXML/QBXMLMsgsRq/CustomerAddRq/CustomerAdd/BillAddress/City',
          message: 'Bad city',
        },
        { line: 5, message: "Element 'Email': [facet 'maxLength'] too long" },
        { line: 9, message: 'Something else' },
      ],
      'CustomerAdd',
      form,
    );
    expect(res.fields).toEqual({
      Name: 'Too long',
      'BillAddress.City': 'Bad city',
      Email: "Element 'Email': [facet 'maxLength'] too long",
    });
    expect(res.general).toEqual(['Something else']);
  });

  it('maps XPath line indexes (1-based) and { fields } maps', () => {
    const res = mapServerErrors(
      {
        fields: { 'InvoiceLineAdd.0.Rate': 'bad' },
        errors: [
          {
            path: '/QBXML/QBXMLMsgsRq/InvoiceAddRq/InvoiceAdd/InvoiceLineAdd[2]/Quantity',
            message: 'q',
          },
        ],
      },
      'InvoiceAdd',
    );
    expect(res.fields['InvoiceLineAdd[1].Quantity']).toBe('q');
    expect(res.fields['InvoiceLineAdd.0.Rate']).toBe('bad');
  });
});

describe('fieldDiff', () => {
  it('compares submitted fields with the current Ret and the edit baseline', () => {
    const submitted = {
      TxnID: 'T1',
      EditSequence: '1',
      Memo: 'Mine',
      CustomerRef: { ListID: 'C2', FullName: 'Beta' },
      InvoiceLineMod: [
        { TxnLineID: 'L1', Amount: '95.00' },
        { TxnLineID: '-1', Amount: '10.00' },
      ],
    };
    const current = {
      TxnID: 'T1',
      EditSequence: '2',
      Memo: 'Theirs',
      CustomerRef: { ListID: 'C1', FullName: 'Acme' },
      InvoiceLineRet: [{ TxnLineID: 'L1', Amount: '80.00' }],
    };
    const base = {
      Memo: 'Original',
      CustomerRef: { ListID: 'C1', FullName: 'Acme' },
      InvoiceLineRet: [{ TxnLineID: 'L1', Amount: '80.00' }],
    };
    const rows = fieldDiff(submitted, current, base);
    expect(rows.map((r) => [r.label, r.base, r.current, r.mine, r.changedRemotely])).toEqual([
      ['Memo', 'Original', 'Theirs', 'Mine', true],
      ['Customer', 'Acme', 'Acme', 'Beta', false],
      ['Invoice Line 1 / Amount', '80.00', '80.00', '95.00', false],
      ['Invoice Line (new) / Amount', '', '', '10.00', false],
    ]);
  });

  it('flattens refs to names and text nodes to values', () => {
    expect(
      flatten({ A: { ListID: '1', FullName: 'X' }, B: { '#text': 'v', '@useMacro': 'm' } }),
    ).toEqual({ A: 'X', B: 'v' });
  });
});
