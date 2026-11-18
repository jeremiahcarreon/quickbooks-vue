// @vitest-environment node
/**
 * Every body the generated forms produce must become XSD-valid qbXML. These
 * tests run the web form model against the real catalog and validate the
 * result with @qbv/qbxml (libxml2 + the Intuit XSD).
 */
import { buildRequest, validate } from '@qbv/qbxml';
import { describe, expect, it } from 'vitest';
import {
  diffForMod,
  fromRet,
  initialValue,
  reapply,
  selectBranch,
  toBody,
  validateValue,
  type FormValue,
} from '@/forms/model';
import { bodyElementOf, ctxFor, entities, fillRequired, objects } from './helpers/catalog';

function expectValid(rq: string, body: Record<string, unknown>) {
  const xml = buildRequest(rq, body);
  const res = validate(xml);
  expect(res.errors, xml).toEqual([]);
  expect(res.valid).toBe(true);
  return xml;
}

const addable = Object.values(entities).filter((e) => e.ops.add);
const modable = Object.values(entities).filter((e) => e.ops.mod);

describe('generated Add forms -> XSD-valid requests', () => {
  it('covers a meaningful number of entities', () => {
    expect(addable.length).toBeGreaterThan(50);
  });

  it.each(addable.map((e) => [e.name, e.ops.add!]))('%s (%s)', (name, rq) => {
    const ctx = ctxFor(name);
    const obj = bodyElementOf(rq);
    const value = fillRequired(obj, initialValue(obj, ctx), ctx);
    expect(validateValue(obj, value, ctx)).toEqual({});
    const body = toBody(obj, value, ctx) ?? {};
    expectValid(rq, body);
  });
});

describe('generated Mod forms -> XSD-valid requests', () => {
  it.each(modable.map((e) => [e.name, e.ops.mod!]))('%s (%s)', (name, rq) => {
    const ctx = ctxFor(name);
    const obj = bodyElementOf(rq);
    const idField = entities[name]!.idField ?? 'ListID';
    const ret = { [idField]: '80000001-1700000000', EditSequence: '1700000000' };
    const base = fromRet(obj, ret, ctx);
    const edited = fillRequired(obj, structuredClone(base), ctx);
    expect(validateValue(obj, edited, ctx)).toEqual({});
    const body = diffForMod(obj, base, edited, ctx);
    if (objects[obj]!.fields.some((f) => f.name === 'EditSequence')) {
      expect(body.EditSequence).toBe('1700000000');
    }
    expectValid(rq, body);
  });
});

describe('realistic forms', () => {
  it('Customer add with address, terms ref and choice of nothing optional', () => {
    const ctx = ctxFor('Customer');
    const v = initialValue('CustomerAdd', ctx);
    Object.assign(v, {
      Name: 'Acme Corp',
      CompanyName: 'Acme Corporation',
      BillAddress: { Addr1: '1 Main St', City: 'Springfield', State: 'IL', PostalCode: '62701' },
      TermsRef: { ListID: '80000002-1700000000', FullName: 'Net 30' },
      CreditLimit: '5000',
      IsActive: true,
      Email: 'ap@acme.test',
    });
    const body = toBody('CustomerAdd', v, ctx)!;
    expect(body.CreditLimit).toBe('5000');
    expect(body.IsActive).toBe('true');
    const xml = expectValid('CustomerAddRq', body);
    expect(xml).toContain('<Name>Acme Corp</Name>');
  });

  it('Invoice add with lines, a rate/percent choice and a line group', () => {
    const ctx = ctxFor('Invoice');
    const v = initialValue('InvoiceAdd', ctx);
    Object.assign(v, {
      CustomerRef: { FullName: 'Acme Corp' },
      TxnDate: '2026-11-17',
      RefNumber: 'INV-1001',
      Memo: 'Thanks & regards <team>',
      InvoiceLineAdd: [
        { ItemRef: { FullName: 'Consulting' }, Desc: 'Hours', Quantity: '10', Rate: '125.5' },
        { ItemRef: { FullName: 'Discount' }, RatePercent: '10' },
        {},
      ],
      InvoiceLineGroupAdd: [{ ItemGroupRef: { FullName: 'Bundle' }, Quantity: '1' }],
    });
    expect(validateValue('InvoiceAdd', v, ctx)).toEqual({});
    const body = toBody('InvoiceAdd', v, ctx)!;
    expect((body.InvoiceLineAdd as unknown[]).length).toBe(2); // empty row dropped
    expectValid('InvoiceAddRq', body);
  });

  it('ReceivePayment: the selected branch of a required choice is the only one sent', () => {
    const ctx = ctxFor('ReceivePayment');
    const v: FormValue = {
      CustomerRef: { FullName: 'Acme Corp' },
      TotalAmount: '100.5',
      IsAutoApply: 'true',
      AppliedToTxnAdd: [{ TxnID: '1A-1700000000', PaymentAmount: '100.50' }],
    };
    selectBranch(v, 'c1', 0);
    let body = toBody('ReceivePaymentAdd', v, ctx)!;
    expect(body.TotalAmount).toBe('100.50');
    expect(body.AppliedToTxnAdd).toBeUndefined();
    expectValid('ReceivePaymentAddRq', body);

    selectBranch(v, 'c1', 1);
    body = toBody('ReceivePaymentAdd', v, ctx)!;
    expect(body.IsAutoApply).toBeUndefined();
    expectValid('ReceivePaymentAddRq', body);

    delete v.__choice;
    v.IsAutoApply = '';
    v.AppliedToTxnAdd = [];
    // nothing chosen: the first branch of a required choice is shown and required
    expect(validateValue('ReceivePaymentAdd', v, ctx)).toEqual({ IsAutoApply: 'Required' });
  });

  it('JournalEntry: debit and credit lines (repeating choice) together', () => {
    const ctx = ctxFor('JournalEntry');
    const v: FormValue = {
      TxnDate: '2026-11-17',
      JournalDebitLine: [{ AccountRef: { FullName: 'Checking' }, Amount: '50' }],
      JournalCreditLine: [{ AccountRef: { FullName: 'Sales' }, Amount: '50.00' }],
    };
    expect(validateValue('JournalEntryAdd', v, ctx)).toEqual({});
    expectValid('JournalEntryAddRq', toBody('JournalEntryAdd', v, ctx)!);
    expect(validateValue('JournalEntryAdd', { TxnDate: '2026-11-17' }, ctx)).toHaveProperty(
      'JournalDebitLine',
    );
  });

  const customerRet = {
    ListID: '80000001-1700000000',
    TimeCreated: '2026-01-01T10:00:00-05:00',
    TimeModified: '2026-01-02T10:00:00-05:00',
    EditSequence: '1700000001',
    Name: 'Acme Corp',
    FullName: 'Acme Corp',
    IsActive: 'true',
    CompanyName: 'Acme Corporation',
    BillAddress: { Addr1: '1 Main St', City: 'Springfield' },
    TermsRef: { ListID: '80000002-1700000000', FullName: 'Net 30' },
    Phone: '555-0100',
    Notes: 'Old note',
    Balance: '120.00',
  };

  it('Customer mod sends ids plus changed fields only, clears emptied text', () => {
    const ctx = ctxFor('Customer');
    const base = fromRet('CustomerMod', customerRet, ctx);
    expect(base.TermsRef).toEqual({ ListID: '80000002-1700000000', FullName: 'Net 30' });
    const edited = structuredClone(base);
    edited.Phone = '555-0199';
    edited.Notes = '';
    (edited.BillAddress as FormValue).City = 'Chicago';
    const body = diffForMod('CustomerMod', base, edited, ctx);
    expect(body).toEqual({
      ListID: '80000001-1700000000',
      EditSequence: '1700000001',
      BillAddress: { Addr1: '1 Main St', City: 'Chicago' },
      Phone: '555-0199',
      Notes: '',
    });
    expectValid('CustomerModRq', body);
  });

  const invoiceRet = {
    TxnID: '1A-1700000000',
    EditSequence: '1700000005',
    TxnDate: '2026-11-01',
    RefNumber: 'INV-1001',
    CustomerRef: { ListID: '80000001-1700000000', FullName: 'Acme Corp' },
    Memo: 'Original',
    InvoiceLineRet: [
      {
        TxnLineID: '1B-1',
        ItemRef: { FullName: 'Consulting' },
        Quantity: '10',
        Rate: '125.00',
        Amount: '1250.00',
      },
      { TxnLineID: '1C-1', ItemRef: { FullName: 'Travel' }, Amount: '80.00' },
    ],
  };

  it('Invoice mod: unchanged lines as TxnLineID only, changed lines in full, new line as -1', () => {
    const ctx = ctxFor('Invoice');
    const base = fromRet('InvoiceMod', invoiceRet, ctx);
    const lines = base.InvoiceLineMod as FormValue[];
    expect(lines).toHaveLength(2);
    expect(lines[0]!.TxnLineID).toBe('1B-1');

    const edited = structuredClone(base);
    const el = edited.InvoiceLineMod as FormValue[];
    el[1]!.Amount = '95';
    el.push({ ItemRef: { FullName: 'Materials' }, Amount: '10.00' });
    const body = diffForMod('InvoiceMod', base, edited, ctx);
    expect(body.Memo).toBeUndefined();
    expect(body.InvoiceLineMod).toEqual([
      { TxnLineID: '1B-1' },
      { TxnLineID: '1C-1', ItemRef: { FullName: 'Travel' }, Amount: '95' },
      { TxnLineID: '-1', ItemRef: { FullName: 'Materials' }, Amount: '10.00' },
    ]);
    expectValid('InvoiceModRq', body);

    // No line change -> no lines sent
    const memoOnly = structuredClone(base);
    memoOnly.Memo = 'Updated';
    const b2 = diffForMod('InvoiceMod', base, memoOnly, ctx);
    expect(b2.InvoiceLineMod).toBeUndefined();
    expectValid('InvoiceModRq', b2);
  });

  it('reload and reapply builds a valid Mod on top of the current object', () => {
    const ctx = ctxFor('Invoice');
    const base = fromRet('InvoiceMod', invoiceRet, ctx);
    const edited = structuredClone(base);
    edited.Memo = 'Mine';
    (edited.InvoiceLineMod as FormValue[])[1]!.Amount = '95.00';
    const submitted = diffForMod('InvoiceMod', base, edited, ctx);

    const current = {
      ...invoiceRet,
      EditSequence: '1700000009',
      RefNumber: 'INV-1001-B',
      InvoiceLineRet: [
        { ...invoiceRet.InvoiceLineRet[0]!, Quantity: '12' },
        invoiceRet.InvoiceLineRet[1]!,
      ],
    };
    const draft = reapply('InvoiceMod', current, submitted, ctx);
    expect(draft.EditSequence).toBe('1700000009');
    expect(draft.RefNumber).toBe('INV-1001-B');
    expect(draft.Memo).toBe('Mine');
    const rows = draft.InvoiceLineMod as FormValue[];
    expect(rows[0]!.Quantity).toBe('12'); // their change kept
    expect(rows[1]!.Amount).toBe('95.00'); // mine reapplied

    const freshBase = fromRet('InvoiceMod', current, ctx);
    const body = diffForMod('InvoiceMod', freshBase, draft, ctx);
    expect(body.EditSequence).toBe('1700000009');
    expect(body.Memo).toBe('Mine');
    expectValid('InvoiceModRq', body);
  });
});
