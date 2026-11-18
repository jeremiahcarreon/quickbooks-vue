import { describe, expect, it } from 'vitest';
import { dec, fmtAmount } from '../lib/decimal';
import {
  balancingAmount,
  blankJournalLine,
  journalAddBody,
  journalBalance,
  journalFromRet,
  journalModBody,
  UnbalancedEntryError,
} from '../lib/journal';
import {
  applyCredits,
  autoApply,
  emptyApplication,
  mergeDocs,
  nextCheckNumber,
  openDocFromRow,
  PaymentError,
  payBillsBodies,
  receivePaymentAddBody,
  receivePaymentFromRet,
  summarize,
  toggleDoc,
  type OpenDoc,
  type PayBillsState,
  type ReceivePaymentState,
} from '../lib/payments';
import { journalSample, ref } from './fixtures';

describe('journal entry balancing', () => {
  it('a balanced entry passes', () => {
    const b = journalBalance(journalSample().lines);
    expect(fmtAmount(b.debits)).toBe('1250.25');
    expect(fmtAmount(b.credits)).toBe('1250.25');
    expect(b.balanced).toBe(true);
    expect(b.invalidLines).toEqual([]);
  });

  it('an unbalanced entry is refused with the difference', () => {
    const s = journalSample();
    s.lines[2]!.credit = '1250.00';
    const b = journalBalance(s.lines);
    expect(b.balanced).toBe(false);
    expect(fmtAmount(b.difference)).toBe('0.25');
    expect(() => journalAddBody(s)).toThrow(UnbalancedEntryError);
    expect(() => journalAddBody(s)).toThrow(/1250.25.*1250.00/);
    expect(balancingAmount(s.lines)).toEqual({ side: 'credit', amount: '0.25' });
  });

  it('lines need an account and exactly one side; zero totals are not balanced', () => {
    const s = journalSample();
    s.lines[1]!.credit = '5';
    expect(journalBalance(s.lines).invalidLines).toEqual([1]);
    const noAcct = journalSample();
    noAcct.lines[0]!.AccountRef = null;
    expect(journalBalance(noAcct.lines).invalidLines).toEqual([0]);
    const neg = journalSample();
    neg.lines[0]!.debit = '-1000';
    expect(journalBalance(neg.lines).balanced).toBe(false);
    expect(journalBalance([blankJournalLine(), blankJournalLine()]).balanced).toBe(false);
  });

  it('suggests the balancing amount for the next line', () => {
    const s = journalSample();
    s.lines = s.lines.slice(0, 2);
    expect(balancingAmount(s.lines)).toEqual({ side: 'credit', amount: '1250.25' });
    expect(balancingAmount(journalSample().lines)).toBeNull();
  });

  it('round-trips a JournalEntryRet into a Mod body with line types', () => {
    const st = journalFromRet({
      TxnID: 'J1',
      EditSequence: '9',
      TxnDate: '2026-11-01',
      RefNumber: '12',
      JournalDebitLine: [
        { TxnLineID: 'L1', AccountRef: { ListID: 'A1', FullName: 'Rent' }, Amount: '100.00' },
      ],
      JournalCreditLine: [
        {
          TxnLineID: 'L2',
          AccountRef: { ListID: 'A2', FullName: 'Cash' },
          Amount: '100.00',
          Memo: 'm',
        },
      ],
    });
    const body = journalModBody(st);
    expect(body.JournalLineMod).toEqual([
      { TxnLineID: 'L1', JournalLineType: 'Debit', AccountRef: { ListID: 'A1' }, Amount: '100.00' },
      {
        TxnLineID: 'L2',
        JournalLineType: 'Credit',
        AccountRef: { ListID: 'A2' },
        Amount: '100.00',
        Memo: 'm',
      },
    ]);
  });
});

const doc = (id: string, due: string, balance: string, extra: Partial<OpenDoc> = {}): OpenDoc => ({
  TxnID: id,
  type: 'Invoice',
  RefNumber: id,
  TxnDate: due,
  DueDate: due,
  original: balance,
  balance,
  ...extra,
});

describe('payment application', () => {
  const docs = [
    doc('C', '2026-10-30', '300.00'),
    doc('A', '2026-09-01', '100.00'),
    doc('B', '2026-10-01', '250.00'),
  ];

  it('auto-applies oldest due first and reports what is left over', () => {
    const r = autoApply(docs, {}, dec('300'));
    expect(r.apps.A!.payment).toBe('100.00');
    expect(r.apps.B!.payment).toBe('200.00');
    expect(r.apps.C!.payment).toBe('');
    expect(r.apps.C!.selected).toBe(false);
    expect(r.unapplied).toBe(0n);
    const over = autoApply(docs, {}, dec('700'));
    expect(fmtAmount(over.unapplied)).toBe('50.00');
  });

  it('auto-apply respects discounts and credits already on a document', () => {
    const apps = {
      A: {
        ...emptyApplication('A'),
        selected: true,
        discount: '2.00',
        credits: [{ CreditTxnID: 'CM', AppliedAmount: '18.00' }],
      },
    };
    const r = autoApply(docs, apps, dec('100'));
    expect(r.apps.A!.payment).toBe('80.00');
    expect(r.apps.A!.discount).toBe('2.00');
    expect(r.apps.B!.payment).toBe('20.00');
  });

  it('checking a document pays what is left; unchecking clears it', () => {
    const on = toggleDoc(docs[1]!, undefined, true);
    expect(on).toMatchObject({ selected: true, payment: '100.00' });
    expect(toggleDoc(docs[1]!, on, false)).toMatchObject({
      selected: false,
      payment: '',
      discount: '',
    });
  });

  it('credits are shared across documents without over-using them', () => {
    const credits = [{ TxnID: 'CM1', type: 'CreditMemo', available: '120.00' }];
    const a = applyCredits(docs[1]!, { ...emptyApplication('A'), payment: '100.00' }, credits, {});
    expect(a.credits).toEqual([{ CreditTxnID: 'CM1', AppliedAmount: '100.00' }]);
    expect(a.payment).toBe('');
    const b = applyCredits(docs[2]!, emptyApplication('B'), credits, { A: a });
    expect(b.credits).toEqual([{ CreditTxnID: 'CM1', AppliedAmount: '20.00' }]);
  });

  it('summarize flags over-application, negative values and a missing discount account', () => {
    const apps = {
      A: { ...emptyApplication('A'), selected: true, payment: '90.00', discount: '20.00' },
      B: { ...emptyApplication('B'), selected: true, payment: '-1' },
    };
    const s = summarize(docs, apps, '50');
    expect(s.issues).toEqual(
      expect.arrayContaining([
        '#A: payment, discount and credits exceed the open balance.',
        '#B: Payment cannot be negative.',
        'Choose a discount account for the discounts.',
        'Applied amounts (89.00) exceed the amount (50.00).',
      ]),
    );
    const ok = summarize(
      docs,
      { A: { ...emptyApplication('A'), selected: true, payment: '100' } },
      '',
    );
    expect(ok.issues).toEqual([]);
    expect(fmtAmount(ok.total)).toBe('100.00');
  });

  it('receivePaymentAddBody refuses invalid input', () => {
    const st: ReceivePaymentState = {
      CustomerRef: null,
      ARAccountRef: null,
      TxnDate: '2026-11-17',
      RefNumber: '',
      TotalAmount: '10',
      PaymentMethodRef: null,
      Memo: '',
      DepositToAccountRef: null,
      DiscountAccountRef: null,
      autoApply: false,
      apps: { A: { ...emptyApplication('A'), selected: true, payment: '20' } },
    };
    try {
      receivePaymentAddBody(st, docs);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentError);
      expect((err as PaymentError).issues[0]).toBe('Choose a customer.');
    }
  });

  it('loads an existing payment and re-opens what it covered', () => {
    const { state, appliedDocs } = receivePaymentFromRet({
      TxnID: 'P',
      EditSequence: '3',
      CustomerRef: { ListID: 'C1', FullName: 'Acme' },
      TotalAmount: '150.00',
      AppliedToTxnRet: [
        {
          TxnID: 'A',
          TxnType: 'Invoice',
          RefNumber: 'A',
          BalanceRemaining: '0.00',
          Amount: '100.00',
        },
      ],
    });
    expect(state.apps.A).toMatchObject({ selected: true, payment: '100.00' });
    expect(appliedDocs[0]!.balance).toBe('100.00');
    const merged = mergeDocs([doc('B', '2026-10-01', '250.00')], appliedDocs);
    expect(merged.map((d) => d.TxnID)).toEqual(['B', 'A']);
  });

  it('open docs come from invoice and bill rows', () => {
    const inv = openDocFromRow({
      type: 'Invoice',
      id: 'I1',
      data: {
        TxnID: 'I1',
        RefNumber: '1001',
        Subtotal: '100.00',
        SalesTaxTotal: '8.25',
        BalanceRemaining: '58.25',
        DueDate: '2026-12-01',
      },
    });
    expect(inv).toMatchObject({ original: '108.25', balance: '58.25', DueDate: '2026-12-01' });
    const b = openDocFromRow({
      type: 'Bill',
      id: 'B1',
      data: {
        TxnID: 'B1',
        AmountDue: '500.00',
        OpenAmount: '125.00',
        VendorRef: { ListID: 'V', FullName: 'Vend' },
      },
    });
    expect(b).toMatchObject({
      original: '500.00',
      balance: '125.00',
      entity: { ListID: 'V', FullName: 'Vend' },
    });
  });
});

describe('pay bills', () => {
  const base: PayBillsState = {
    TxnDate: '2026-11-17',
    method: 'check',
    BankAccountRef: null,
    CreditCardAccountRef: null,
    APAccountRef: null,
    toBePrinted: false,
    firstCheckNumber: '',
    Memo: '',
    DiscountAccountRef: null,
    apps: {},
  };

  it('requires a selection, an account and a check number', () => {
    try {
      payBillsBodies(base, []);
      expect.unreachable();
    } catch (err) {
      expect((err as PaymentError).issues).toEqual([
        'Select at least one bill to pay.',
        'Choose the bank account to pay from.',
        'Enter the first check number, or choose "To be printed".',
      ]);
    }
  });

  it('groups by vendor and totals each payment', () => {
    const bills = [
      doc('B1', '2026-11-01', '100.00', { type: 'Bill', entity: ref('V1', 'v1') }),
      doc('B2', '2026-11-02', '40.00', { type: 'Bill', entity: ref('V1', 'v1') }),
      doc('B3', '2026-11-03', '10.00', { type: 'Bill', entity: ref('V2', 'v2') }),
    ];
    const apps = Object.fromEntries(bills.map((b) => [b.TxnID, toggleDoc(b, undefined, true)]));
    const reqs = payBillsBodies(
      { ...base, BankAccountRef: ref('Checking'), firstCheckNumber: '1009', apps },
      bills,
    );
    expect(reqs.map((r) => [r.vendor.FullName, fmtAmount(r.amount), r.body.RefNumber])).toEqual([
      ['V1', '140.00', '1009'],
      ['V2', '10.00', '1010'],
    ]);
  });

  it('numbers checks after any prefix', () => {
    expect(nextCheckNumber('0999', 1)).toBe('1000');
    expect(nextCheckNumber('CHK-007', 2)).toBe('CHK-009');
    expect(nextCheckNumber('EFT', 0)).toBe('EFT');
    expect(nextCheckNumber('EFT', 1)).toBe('EFT-2');
  });
});
