// @vitest-environment node
/**
 * Every body the transaction forms build must (1) use catalog element names in
 * catalog order and (2) produce a qbXML request that validates against the
 * Intuit XSD via @qbv/qbxml.
 */
import { buildRequest, catalog, validate } from '@qbv/qbxml';
import { describe, expect, it } from 'vitest';
import type { MetaDefs, MetaObject } from '../lib/api';
import {
  blankDepositLine,
  depositAddBody,
  depositModBody,
  type DepositState,
} from '../lib/deposit';
import { journalAddBody, journalModBody } from '../lib/journal';
import { buildBody, orderBody } from '../lib/payload';
import {
  payBillsBodies,
  receivePaymentAddBody,
  receivePaymentModBody,
  type OpenDoc,
  type ReceivePaymentState,
} from '../lib/payments';
import { SPECS } from '../lib/specs';
import { journalSample, ref, sampleState } from './fixtures';

type Json = Record<string, unknown>;

/** Assert keys follow the catalog's field order, recursively, and that every key exists. */
function expectSchemaOrder(body: Json, objName: string, path = objName): void {
  const def = catalog.objects[objName];
  expect(def, `catalog object ${objName}`).toBeDefined();
  const names = def!.fields.map((f) => f.name);
  let last = -1;
  for (const [k, v] of Object.entries(body)) {
    const idx = names.indexOf(k);
    expect(idx, `${path}.${k} is not a field of ${objName}`).toBeGreaterThanOrEqual(0);
    expect(idx, `${path}.${k} is out of schema order`).toBeGreaterThan(last);
    last = idx;
    const field = def!.fields[idx]!;
    if (field.kind === 'complex' && field.children) {
      const items = Array.isArray(v) ? v : [v];
      items.forEach((item, i) => {
        expect(typeof item, `${path}.${k}[${i}]`).toBe('object');
        expectSchemaOrder(item as Json, field.children!, `${path}.${k}[${i}]`);
      });
    } else {
      expect(typeof v, `${path}.${k} should be a string leaf`).toBe('string');
    }
  }
}

function expectValidRequest(rq: string, body: Json): string {
  const xml = buildRequest(rq, body, { requestID: '1' });
  const res = validate(xml);
  expect(res.errors).toEqual([]);
  expect(res.valid).toBe(true);
  return xml;
}

function rqFor(type: string, op: 'add' | 'mod'): string {
  const rq = catalog.entities[type]?.ops[op];
  expect(rq, `${type} has a ${op} request`).toBeTruthy();
  return rq!;
}

describe('spec-driven forms build XSD-valid requests', () => {
  for (const spec of SPECS) {
    it(`${spec.label}: Add body uses catalog names/order and validates`, () => {
      const body = buildBody(spec, sampleState(spec, 'add'), 'add');
      expectSchemaOrder(body, spec.addObject);
      const xml = expectValidRequest(rqFor(spec.type, 'add'), { [spec.addObject]: body });
      expect(xml).toContain(`<${spec.addObject}>`);
      // Blank lines are dropped; line amounts typed by the user are sent with two decimals.
      for (const s of spec.lines) {
        const lines = body[s.add] as Json[];
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.every((l) => Object.keys(l).length > 0)).toBe(true);
      }
    });

    if (spec.modObject) {
      it(`${spec.label}: Mod body uses catalog names/order and validates`, () => {
        const body = buildBody(spec, sampleState(spec, 'mod'), 'mod');
        expectSchemaOrder(body, spec.modObject!);
        expect(Object.keys(body).slice(0, 2)).toEqual(['TxnID', 'EditSequence']);
        expectValidRequest(rqFor(spec.type, 'mod'), { [spec.modObject!]: body });
        for (const s of spec.lines) {
          const lines = body[s.mod] as Json[];
          expect(lines[0]!.TxnLineID).toBe(`${s.key.toUpperCase()}-1`);
          expect(lines.at(-1)!.TxnLineID).toBe('-1');
        }
      });
    }
  }

  it('Mod with every line of a section removed sends the Clear flag', () => {
    const bill = SPECS.find((s) => s.type === 'Bill')!;
    const state = sampleState(bill, 'mod');
    state.lines.expenses = [];
    const body = buildBody(bill, state, 'mod');
    expect(body.ClearExpenseLines).toBe('true');
    expect(body.ExpenseLineMod).toBeUndefined();
    expectSchemaOrder(body, 'BillMod');
    expectValidRequest('BillModRq', { BillMod: body });
  });

  it('orderBody restores schema order from meta definitions', () => {
    const defs: MetaDefs = new Map(
      Object.values(catalog.objects).map((o) => [o.name, o as unknown as MetaObject]),
    );
    const scrambled = {
      InvoiceLineAdd: [{ Amount: '10.00', ItemRef: { FullName: 'X' }, Desc: 'd' }],
      Memo: 'm',
      TxnDate: '2026-01-01',
      CustomerRef: { FullName: 'C', ListID: '1-1' },
    };
    const ordered = orderBody(scrambled, 'InvoiceAdd', defs);
    expect(Object.keys(ordered)).toEqual(['CustomerRef', 'TxnDate', 'Memo', 'InvoiceLineAdd']);
    expect(Object.keys((ordered.InvoiceLineAdd as Json[])[0]!)).toEqual([
      'ItemRef',
      'Desc',
      'Amount',
    ]);
    expect(Object.keys(ordered.CustomerRef as Json)).toEqual(['ListID', 'FullName']);
    expectSchemaOrder(ordered, 'InvoiceAdd');
    // And buildBody with meta gives the same result as the spec order.
    for (const spec of SPECS) {
      const withMeta = buildBody(spec, sampleState(spec, 'add'), 'add', defs);
      expect(JSON.stringify(withMeta)).toBe(
        JSON.stringify(buildBody(spec, sampleState(spec, 'add'), 'add')),
      );
    }
  });
});

describe('journal entry', () => {
  it('Add body is balanced, ordered and XSD-valid', () => {
    const body = journalAddBody(journalSample());
    expectSchemaOrder(body, 'JournalEntryAdd');
    expect((body.JournalDebitLine as Json[]).length).toBe(2);
    expect((body.JournalCreditLine as Json[]).length).toBe(1);
    expectValidRequest('JournalEntryAddRq', { JournalEntryAdd: body });
  });

  it('Mod body is ordered and XSD-valid', () => {
    const st = journalSample();
    st.TxnID = '99-1700000000';
    st.EditSequence = '1700000999';
    st.lines[0]!.TxnLineID = '99-1';
    const body = journalModBody(st);
    expectSchemaOrder(body, 'JournalEntryMod');
    const lines = body.JournalLineMod as Json[];
    expect(lines.map((l) => l.JournalLineType)).toEqual(['Debit', 'Debit', 'Credit']);
    expect(lines.map((l) => l.TxnLineID)).toEqual(['99-1', '-1', '-1']);
    expectValidRequest('JournalEntryModRq', { JournalEntryMod: body });
  });
});

const invoices: OpenDoc[] = [
  {
    TxnID: 'INV-1',
    type: 'Invoice',
    RefNumber: '1001',
    TxnDate: '2026-09-01',
    DueDate: '2026-10-01',
    original: '500.00',
    balance: '500.00',
  },
  {
    TxnID: 'INV-2',
    type: 'Invoice',
    RefNumber: '1002',
    TxnDate: '2026-10-01',
    DueDate: '2026-10-31',
    original: '300.00',
    balance: '300.00',
  },
];

function paymentState(): ReceivePaymentState {
  return {
    CustomerRef: ref('Acme Corp', '80000001-1700000000'),
    ARAccountRef: null,
    TxnDate: '2026-11-17',
    RefNumber: '5521',
    TotalAmount: '600',
    PaymentMethodRef: ref('Check'),
    Memo: 'Thanks',
    DepositToAccountRef: ref('Undeposited Funds'),
    DiscountAccountRef: ref('Discounts Given'),
    autoApply: false,
    apps: {
      'INV-1': {
        TxnID: 'INV-1',
        selected: true,
        payment: '490.00',
        discount: '10.00',
        credits: [],
      },
      'INV-2': {
        TxnID: 'INV-2',
        selected: true,
        payment: '110',
        discount: '',
        credits: [{ CreditTxnID: 'CM-1', AppliedAmount: '40' }],
      },
    },
  };
}

describe('receive payment', () => {
  it('Add body with discounts and credits is ordered and XSD-valid', () => {
    const body = receivePaymentAddBody(paymentState(), invoices, [
      { TxnID: 'CM-1', type: 'CreditMemo', available: '40.00' },
    ]);
    expectSchemaOrder(body, 'ReceivePaymentAdd');
    expect(body.TotalAmount).toBe('600.00');
    expectValidRequest('ReceivePaymentAddRq', { ReceivePaymentAdd: body });
  });

  it('Add body without applications uses IsAutoApply', () => {
    const st = { ...paymentState(), apps: {}, autoApply: true };
    const body = receivePaymentAddBody(st, invoices);
    expect(body.IsAutoApply).toBe('true');
    expect(body.AppliedToTxnAdd).toBeUndefined();
    expectSchemaOrder(body, 'ReceivePaymentAdd');
    expectValidRequest('ReceivePaymentAddRq', { ReceivePaymentAdd: body });
  });

  it('Mod body is ordered and XSD-valid', () => {
    const st = { ...paymentState(), TxnID: 'RP-1', EditSequence: '17' };
    const body = receivePaymentModBody(st, invoices, [
      { TxnID: 'CM-1', type: 'CreditMemo', available: '40.00' },
    ]);
    expectSchemaOrder(body, 'ReceivePaymentMod');
    expectValidRequest('ReceivePaymentModRq', { ReceivePaymentMod: body });
  });
});

describe('pay bills', () => {
  const bills: OpenDoc[] = [
    {
      TxnID: 'B-1',
      type: 'Bill',
      RefNumber: 'A-1',
      DueDate: '2026-11-01',
      original: '200.00',
      balance: '200.00',
      entity: ref('Zeta Supply', 'V-2'),
    },
    {
      TxnID: 'B-2',
      type: 'Bill',
      RefNumber: 'A-2',
      DueDate: '2026-11-05',
      original: '75.00',
      balance: '75.00',
      entity: ref('Alpha Parts', 'V-1'),
    },
    {
      TxnID: 'B-3',
      type: 'Bill',
      RefNumber: 'A-3',
      DueDate: '2026-11-06',
      original: '50.00',
      balance: '50.00',
      entity: ref('Alpha Parts', 'V-1'),
    },
  ];
  const apps = {
    'B-1': { TxnID: 'B-1', selected: true, payment: '196.00', discount: '4.00', credits: [] },
    'B-2': { TxnID: 'B-2', selected: true, payment: '75', discount: '', credits: [] },
    'B-3': {
      TxnID: 'B-3',
      selected: true,
      payment: '30',
      discount: '',
      credits: [{ CreditTxnID: 'VC-1', AppliedAmount: '20' }],
    },
  };

  it('one XSD-valid BillPaymentCheckAdd per vendor with sequential check numbers', () => {
    const reqs = payBillsBodies(
      {
        TxnDate: '2026-11-17',
        method: 'check',
        BankAccountRef: ref('Checking'),
        CreditCardAccountRef: null,
        APAccountRef: null,
        toBePrinted: false,
        firstCheckNumber: '0998',
        Memo: '',
        DiscountAccountRef: ref('Discounts Taken'),
        apps,
      },
      bills,
      [{ TxnID: 'VC-1', type: 'VendorCredit', available: '20.00' }],
    );
    expect(reqs.map((r) => r.vendor.FullName)).toEqual(['Alpha Parts', 'Zeta Supply']);
    expect(reqs.map((r) => r.body.RefNumber)).toEqual(['0998', '0999']);
    for (const r of reqs) {
      expect(r.type).toBe('BillPaymentCheck');
      expectSchemaOrder(r.body, 'BillPaymentCheckAdd');
      expectValidRequest('BillPaymentCheckAddRq', { BillPaymentCheckAdd: r.body });
    }
  });

  it('credit card bill payments are XSD-valid; to-be-printed checks too', () => {
    const base = {
      TxnDate: '2026-11-17',
      BankAccountRef: ref('Checking'),
      CreditCardAccountRef: ref('Visa'),
      APAccountRef: ref('Accounts Payable'),
      toBePrinted: true,
      firstCheckNumber: '',
      Memo: 'Batch',
      DiscountAccountRef: ref('Discounts Taken'),
      apps,
    };
    for (const r of payBillsBodies({ ...base, method: 'creditcard' }, bills)) {
      expectSchemaOrder(r.body, 'BillPaymentCreditCardAdd');
      expectValidRequest('BillPaymentCreditCardAddRq', { BillPaymentCreditCardAdd: r.body });
    }
    for (const r of payBillsBodies({ ...base, method: 'check' }, bills)) {
      expect(r.body.IsToBePrinted).toBe('true');
      expectValidRequest('BillPaymentCheckAddRq', { BillPaymentCheckAdd: r.body });
    }
  });
});

describe('deposit', () => {
  const state = (): DepositState => ({
    TxnDate: '2026-11-17',
    DepositToAccountRef: ref('Checking', 'A-1'),
    Memo: 'Deposit',
    payments: [
      { TxnID: 'RP-1', type: 'ReceivePayment', amount: '600.00', selected: true },
      { TxnID: 'RP-2', type: 'ReceivePayment', amount: '50.00', selected: false },
    ],
    lines: [
      {
        ...blankDepositLine(),
        EntityRef: ref('Acme Corp'),
        AccountRef: ref('Other Income'),
        Memo: 'Refund',
        CheckNumber: '77',
        PaymentMethodRef: ref('Check'),
        ClassRef: ref('East'),
        Amount: '25',
      },
      blankDepositLine(),
    ],
  });

  it('Add body (payments + manual lines) is ordered and XSD-valid', () => {
    const body = depositAddBody(state());
    expectSchemaOrder(body, 'DepositAdd');
    expect((body.DepositLineAdd as Json[]).length).toBe(2);
    expectValidRequest('DepositAddRq', { DepositAdd: body });
  });

  it('Mod body keeps payment lines by TxnLineID and is XSD-valid', () => {
    const st = state();
    st.TxnID = 'D-1';
    st.EditSequence = '5';
    st.lines.unshift({
      ...blankDepositLine(),
      TxnLineID: 'D-1-1',
      paymentTxnID: 'RP-0',
      Amount: '10.00',
    });
    const body = depositModBody(st);
    expectSchemaOrder(body, 'DepositMod');
    expect((body.DepositLineMod as Json[])[1]).toEqual({ TxnLineID: 'D-1-1' });
    expectValidRequest('DepositModRq', { DepositMod: body });
  });
});
