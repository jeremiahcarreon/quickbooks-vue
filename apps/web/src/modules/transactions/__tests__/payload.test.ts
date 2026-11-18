import { describe, expect, it } from 'vitest';
import {
  collectObjectDefs,
  conflictCurrent,
  normalizeCommand,
  normalizeHealth,
  normalizeList,
  normalizeRow,
  resultObjectId,
} from '../lib/api';
import { diffFields } from '../lib/diff';
import { buildBody, checkForm, stateFromRet } from '../lib/payload';
import { refOut, sameRef } from '../lib/refs';
import { formPathFor, SPECIAL_FORMS, SPECS, specBySlug } from '../lib/specs';
import { hotkeyAction } from '../lib/useHotkeys';
import { ref, sampleState } from './fixtures';

const invoice = specBySlug('invoice')!;

const invoiceRet = {
  TxnID: '1-1700',
  EditSequence: '1700000001',
  CustomerRef: { ListID: 'C1', FullName: 'Acme' },
  TxnDate: '2026-11-01',
  RefNumber: '1001',
  TermsRef: { ListID: 'T1', FullName: 'Net 30' },
  DueDate: '2026-12-01',
  IsToBePrinted: 'false',
  BillAddress: { Addr1: 'Acme', City: 'Springfield' },
  Subtotal: '300.00',
  SalesTaxTotal: '0.00',
  BalanceRemaining: '300.00',
  InvoiceLineRet: [
    {
      TxnLineID: 'L1',
      ItemRef: { ListID: 'I1', FullName: 'Consulting' },
      Desc: 'Hours',
      Quantity: '2',
      Rate: '100.00',
      Amount: '200.00',
    },
    { TxnLineID: 'L2', ItemRef: { ListID: 'I2', FullName: 'Setup' }, Amount: '100.00' },
  ],
};

describe('Ret -> form -> Mod body', () => {
  it('loads header, refs, booleans, addresses and lines with their TxnLineIDs', () => {
    const { state, readOnlyReason } = stateFromRet(invoice, invoiceRet);
    expect(readOnlyReason).toBeUndefined();
    expect(state.TxnID).toBe('1-1700');
    expect(state.header.CustomerRef).toEqual({ ListID: 'C1', FullName: 'Acme' });
    expect(state.header.IsToBePrinted).toBe(false);
    expect(state.header.BillAddress).toEqual({ Addr1: 'Acme', City: 'Springfield' });
    expect(state.lines.lines!.map((l) => l.TxnLineID)).toEqual(['L1', 'L2']);
    // A line saved without a rate keeps its amount.
    expect(state.lines.lines![1]!.lastEdited).toBe('amount');
  });

  it('builds a Mod body that keeps lines, sends edits and adds new lines as -1', () => {
    const { state } = stateFromRet(invoice, invoiceRet);
    state.header.Memo = 'Updated';
    state.lines.lines!.push({ key: 'n', values: { ItemRef: ref('Travel', 'I3'), Amount: '45' } });
    const body = buildBody(invoice, state, 'mod');
    expect(body.TxnID).toBe('1-1700');
    expect(body.EditSequence).toBe('1700000001');
    expect(body.Memo).toBe('Updated');
    expect(body.InvoiceLineMod).toEqual([
      { TxnLineID: 'L1', ItemRef: { ListID: 'I1' }, Desc: 'Hours', Quantity: '2', Rate: '100' },
      { TxnLineID: 'L2', ItemRef: { ListID: 'I2' }, Amount: '100.00' },
      { TxnLineID: '-1', ItemRef: { ListID: 'I3' }, Amount: '45.00' },
    ]);
  });

  it('refuses to edit lines of a transaction with item groups', () => {
    const r = stateFromRet(invoice, { ...invoiceRet, InvoiceLineGroupRet: [{ TxnLineID: 'G1' }] });
    expect(r.readOnlyReason).toMatch(/item group/);
  });

  it('a Mod without EditSequence is refused', () => {
    const st = sampleState(invoice, 'mod');
    delete st.EditSequence;
    expect(() => buildBody(invoice, st, 'mod')).toThrow(/EditSequence/);
  });

  it('conflict diff lists changed header fields', () => {
    const { state } = stateFromRet(invoice, invoiceRet);
    state.header.RefNumber = '1001-A';
    const theirs = stateFromRet(invoice, { ...invoiceRet, Memo: 'Changed in QB' }).state.header;
    expect(
      diffFields(invoice.header, state.header, theirs).map((d) => [d.field, d.mine, d.theirs]),
    ).toEqual([
      ['RefNumber', '1001-A', '1001'],
      ['Memo', '', 'Changed in QB'],
    ]);
  });
});

describe('client-side checks', () => {
  it('required fields, numbers, lengths from meta, and at least one line', () => {
    const defs = collectObjectDefs({
      objects: {
        InvoiceAdd: { name: 'InvoiceAdd', fields: [{ name: 'RefNumber', maxLength: 11 }] },
      },
    });
    const st = { header: { RefNumber: '123456789012' }, lines: { lines: [] } };
    const issues = checkForm(invoice, st, 'add', defs).map((i) => i.message);
    expect(issues).toEqual([
      'Customer:Job is required.',
      'Invoice # is longer than 11 characters.',
      'Add at least one line.',
    ]);
    const bad = sampleState(invoice, 'add');
    bad.lines.lines![0]!.values.Quantity = 'two';
    expect(checkForm(invoice, bad, 'add').map((i) => i.message)).toContain(
      'Line 1: Qty is not a number.',
    );
  });

  it('expense lines need an account', () => {
    const bill = specBySlug('bill')!;
    const st = sampleState(bill, 'add');
    st.lines.expenses![0]!.values.AccountRef = null;
    expect(checkForm(bill, st, 'add').map((i) => i.message)).toContain(
      'Line 1: choose an account.',
    );
  });
});

describe('API adapters', () => {
  it('normalizes read-model rows and pages', () => {
    const list = normalizeList(
      {
        items: [
          {
            type: 'Customer',
            qb_id: 'C1',
            name: 'Acme',
            edit_sequence: '5',
            data: { ListID: 'C1', FullName: 'Acme' },
          },
        ],
        total: 10,
        page: 2,
        pageSize: 1,
      },
      'Customer',
    );
    expect(list).toMatchObject({ total: 10, page: 2, pageSize: 1 });
    expect(list.items[0]).toMatchObject({
      id: 'C1',
      name: 'Acme',
      editSequence: '5',
      data: { FullName: 'Acme' },
    });
    expect(normalizeRow({ TxnID: 'T1', RefNumber: '9' }, 'Invoice')).toMatchObject({
      id: 'T1',
      type: 'Invoice',
      refNumber: '9',
    });
    expect(normalizeList([{ ListID: 'X' }], 'Class').items[0]!.id).toBe('X');
  });

  it('normalizes commands and finds created ids and conflict data', () => {
    expect(
      normalizeCommand({ id: 'c', status: 'failed', status_code: 3100, status_message: 'dup' }),
    ).toEqual({
      id: 'c',
      status: 'failed',
      statusCode: 3100,
      statusMessage: 'dup',
      result: undefined,
      objectId: undefined,
    });
    expect(resultObjectId({ rets: [{ InvoiceRet: { TxnID: 'NEW-1' } }] })).toBe('NEW-1');
    expect(resultObjectId(null)).toBeUndefined();
    expect(conflictCurrent({ current: { data: { TxnID: 'x', EditSequence: '2' } } })).toEqual({
      TxnID: 'x',
      EditSequence: '2',
    });
    expect(conflictCurrent({ current: { TxnID: 'y' } })).toEqual({ TxnID: 'y' });
  });

  it('collects object definitions from any meta envelope', () => {
    const defs = collectObjectDefs({
      entity: { name: 'Invoice' },
      add: { name: 'InvoiceAdd', fields: [{ name: 'CustomerRef' }] },
      objects: { InvoiceLineAdd: { fields: [{ name: 'ItemRef' }] } },
    });
    expect([...defs.keys()].sort()).toEqual(['InvoiceAdd', 'InvoiceLineAdd']);
  });

  it('normalizes health', () => {
    expect(
      normalizeHealth({
        status: 'ok',
        db: { ok: true },
        redis: 'up',
        relay: { connected: false, error: 'timeout' },
      }),
    ).toMatchObject({
      ok: true,
      parts: { db: { ok: true }, redis: { ok: true }, relay: { ok: false, detail: 'timeout' } },
    });
    expect(normalizeHealth({ checks: { database: true, relay: true } }).ok).toBe(true);
  });
});

describe('refs, specs and hotkeys', () => {
  it('refs prefer ListID', () => {
    expect(refOut(ref('Acme', 'C1'))).toEqual({ ListID: 'C1' });
    expect(refOut(ref('Acme'))).toEqual({ FullName: 'Acme' });
    expect(refOut({ FullName: '  ' })).toBeNull();
    expect(sameRef({ ListID: 'a', FullName: 'x' }, { ListID: 'a' })).toBe(true);
    expect(sameRef({ FullName: 'ACME' }, { FullName: 'acme' })).toBe(true);
  });

  it('every spec has unique slugs and types and maps to a form path', () => {
    const slugs = [...SPECS.map((s) => s.slug), ...SPECIAL_FORMS.map((s) => s.slug)];
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(formPathFor('Invoice', 'T 1')).toBe('/transactions/invoice/T%201');
    expect(formPathFor('ReceivePayment')).toBe('/transactions/receive-payment/new');
    expect(formPathFor('BillPaymentCheck', 'x')).toBeNull();
    expect(formPathFor('Paycheck')).toBeNull();
  });

  it('maps keyboard shortcuts', () => {
    const k = (key: string, mods: Partial<KeyboardEvent> = {}) =>
      hotkeyAction({
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        ...mods,
      });
    expect(k('s', { ctrlKey: true })).toBe('save');
    expect(k('s', { metaKey: true })).toBe('save');
    expect(k('S', { altKey: true })).toBe('save');
    expect(k('n', { altKey: true })).toBe('saveNew');
    expect(k('Insert', { ctrlKey: true })).toBe('insertLine');
    expect(k('Delete', { ctrlKey: true })).toBe('deleteLine');
    expect(k('s')).toBeNull();
  });
});
