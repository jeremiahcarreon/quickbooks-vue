import { describe, expect, it } from 'vitest';
import { ok, ref, ret, testEngine, type TestEngine } from './helpers.js';

function company(): TestEngine {
  const t = testEngine('2026-05-01T16:00:00Z');
  for (const [Name, AccountType] of [
    ['Checking', 'Bank'],
    ['Accounts Receivable', 'AccountsReceivable'],
    ['Undeposited Funds', 'OtherCurrentAsset'],
    ['Accounts Payable', 'AccountsPayable'],
    ['Sales Tax Payable', 'OtherCurrentLiability'],
    ['Service Income', 'Income'],
    ['Parts Sales', 'Income'],
    ['Rent', 'Expense'],
    ['Parts Expense', 'CostOfGoodsSold'],
  ])
    ok(t.rq('AccountAddRq', { Name, AccountType }));
  ok(t.rq('SalesTaxCodeAddRq', { Name: 'Tax', IsTaxable: true }));
  ok(t.rq('SalesTaxCodeAddRq', { Name: 'Non', IsTaxable: false }));
  ok(t.rq('VendorAddRq', { Name: 'Tax Agency' }));
  ok(t.rq('ItemSalesTaxAddRq', { Name: 'County', TaxRate: 8.25, TaxVendorRef: ref('Tax Agency') }));
  ok(t.rq('StandardTermsAddRq', { Name: 'Net 30', StdDueDays: 30 }));
  ok(
    t.rq('ItemServiceAddRq', {
      Name: 'Labor',
      SalesTaxCodeRef: ref('Non'),
      SalesOrPurchase: { Desc: 'Labor per hour', Price: 100, AccountRef: ref('Service Income') },
    }),
  );
  ok(
    t.rq('ItemNonInventoryAddRq', {
      Name: 'Filter',
      SalesTaxCodeRef: ref('Tax'),
      SalesAndPurchase: {
        SalesDesc: 'Filter',
        SalesPrice: 20,
        IncomeAccountRef: ref('Parts Sales'),
        PurchaseCost: 8,
        ExpenseAccountRef: ref('Parts Expense'),
      },
    }),
  );
  ok(
    t.rq('CustomerAddRq', {
      Name: 'Acme',
      TermsRef: ref('Net 30'),
      ItemSalesTaxRef: ref('County'),
    }),
  );
  ok(t.rq('CustomerAddRq', { Name: 'Other Co' }));
  ok(t.rq('VendorAddRq', { Name: 'Supply Co' }));
  return t;
}

function invoice(t: TestEngine, extra: Record<string, unknown> = {}) {
  return ret(
    t.rq('InvoiceAddRq', {
      CustomerRef: ref('Acme'),
      TxnDate: '2026-04-10',
      InvoiceLineAdd: [
        { ItemRef: ref('Labor'), Quantity: 2 },
        { ItemRef: ref('Filter'), Quantity: 3, Rate: 25 },
      ],
      ...extra,
    }),
  );
}

describe('transactions', () => {
  it('computes lines, sales tax, totals, terms and defaults', () => {
    const t = company();
    const inv = invoice(t);
    expect(inv.TxnID).toMatch(/^[0-9A-F]+-\d{10}$/);
    expect(inv).toMatchObject({
      RefNumber: '1001',
      TxnNumber: expect.any(String),
      TxnDate: '2026-04-10',
      DueDate: '2026-05-10',
      TermsRef: { FullName: 'Net 30' },
      ARAccountRef: { FullName: 'Accounts Receivable' },
      ItemSalesTaxRef: { FullName: 'County' },
      Subtotal: '275.00',
      SalesTaxPercentage: '8.25',
      SalesTaxTotal: '6.19',
      AppliedAmount: '0.00',
      BalanceRemaining: '281.19',
      IsPaid: 'false',
    });
    const lines = inv.InvoiceLineRet as Record<string, unknown>[];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      Desc: 'Labor per hour',
      Quantity: '2',
      Rate: '100',
      Amount: '200.00',
    });
    expect(lines[1]).toMatchObject({ Quantity: '3', Rate: '25', Amount: '75.00' });
    expect(lines[0]!.TxnLineID).toMatch(/^[0-9A-F]+-\d+$/);
    expect(invoice(t).RefNumber).toBe('1002');
  });

  it('omits line items unless IncludeLineItems, and filters by date, entity and ref number', () => {
    const t = company();
    const a = invoice(t);
    invoice(t, { TxnDate: '2026-04-20', CustomerRef: ref('Other Co') });
    invoice(t, { TxnDate: '2026-04-25', RefNumber: 'A-77' });
    const all = t.rq('InvoiceQueryRq', {});
    expect(all.rets).toHaveLength(3);
    expect(all.rets[0]!.InvoiceLineRet).toBeUndefined();
    const withLines = t.rq('InvoiceQueryRq', { TxnID: a.TxnID, IncludeLineItems: true });
    expect(withLines.rets[0]!.InvoiceLineRet).toHaveLength(2);
    expect(
      t.rq('InvoiceQueryRq', {
        TxnDateRangeFilter: { FromTxnDate: '2026-04-15', ToTxnDate: '2026-04-30' },
      }).rets,
    ).toHaveLength(2);
    expect(t.rq('InvoiceQueryRq', { EntityFilter: { FullName: 'Other Co' } }).rets).toHaveLength(1);
    expect(t.rq('InvoiceQueryRq', { RefNumber: 'a-77' }).rets).toHaveLength(1);
    expect(
      t.rq('InvoiceQueryRq', {
        RefNumberFilter: { MatchCriterion: 'StartsWith', RefNumber: '100' },
      }).rets,
    ).toHaveLength(2);
    expect(
      t.rq('InvoiceQueryRq', {
        RefNumberRangeFilter: { FromRefNumber: '1002', ToRefNumber: '1005' },
      }).rets,
    ).toHaveLength(1);
    expect(
      t.rq('InvoiceQueryRq', { AccountFilter: { FullName: 'Accounts Receivable' } }).rets,
    ).toHaveLength(3);
    expect(t.rq('InvoiceQueryRq', { PaidStatus: 'PaidOnly' }).statusCode).toBe(1);
    const page = t.rq('InvoiceQueryRq', { MaxReturned: 2 }, { iterator: 'Start' });
    expect(page.rets).toHaveLength(2);
    expect(page.iteratorRemainingCount).toBe(1);
  });

  it('applies customer payments, updating invoice balance, IsPaid, LinkedTxn and TimeModified', () => {
    const t = company();
    const inv = invoice(t);
    t.advance(10_000);
    const p1 = ret(
      t.rq('ReceivePaymentAddRq', {
        CustomerRef: ref('Acme'),
        TxnDate: '2026-04-20',
        TotalAmount: 100,
        AppliedToTxnAdd: [{ TxnID: inv.TxnID, PaymentAmount: 100 }],
      }),
    );
    expect(p1).toMatchObject({
      TotalAmount: '100.00',
      UnusedPayment: '0.00',
      DepositToAccountRef: { FullName: 'Undeposited Funds' },
      AppliedToTxnRet: [
        {
          TxnID: inv.TxnID,
          TxnType: 'Invoice',
          RefNumber: '1001',
          Amount: '100.00',
          BalanceRemaining: '181.19',
        },
      ],
    });
    const after = t.rq('InvoiceQueryRq', { TxnID: inv.TxnID, IncludeLinkedTxns: true }).rets[0]!;
    expect(after).toMatchObject({
      BalanceRemaining: '181.19',
      AppliedAmount: '-100.00',
      IsPaid: 'false',
    });
    expect(after.LinkedTxn).toEqual([
      {
        TxnID: p1.TxnID,
        TxnType: 'ReceivePayment',
        TxnDate: '2026-04-20',
        LinkType: 'AMTTYPE',
        Amount: '-100.00',
      },
    ]);
    expect(after.TimeModified).not.toBe(inv.TimeModified);
    expect(after.EditSequence).not.toBe(inv.EditSequence);
    expect(t.rq('CustomerQueryRq', { FullName: 'Acme' }).rets[0]!.Balance).toBe('181.19');

    // Overpaying an invoice is refused.
    const over = t.rq('ReceivePaymentAddRq', {
      CustomerRef: ref('Acme'),
      TotalAmount: 500,
      AppliedToTxnAdd: [{ TxnID: inv.TxnID, PaymentAmount: 500 }],
    });
    expect(over.statusCode).toBe(3180);
    // Auto-apply pays the rest and leaves the overpayment unused.
    const p2 = ret(
      t.rq('ReceivePaymentAddRq', {
        CustomerRef: ref('Acme'),
        TotalAmount: 200,
        IsAutoApply: true,
      }),
    );
    expect(p2).toMatchObject({
      UnusedPayment: '18.81',
      AppliedToTxnRet: [{ TxnID: inv.TxnID, Amount: '181.19', BalanceRemaining: '0.00' }],
    });
    const paid = t.rq('InvoiceQueryRq', { TxnID: inv.TxnID }).rets[0]!;
    expect(paid).toMatchObject({ BalanceRemaining: '0.00', IsPaid: 'true' });
    expect(t.rq('InvoiceQueryRq', { PaidStatus: 'PaidOnly' }).rets).toHaveLength(1);
    expect(t.rq('CustomerQueryRq', { FullName: 'Acme' }).rets[0]!.Balance).toBe('-18.81');

    // An invoice with payments cannot be deleted; deleting the payment restores the balance.
    expect(t.rq('TxnDelRq', { TxnDelType: 'Invoice', TxnID: inv.TxnID }).statusCode).toBe(3180);
    ok(t.rq('TxnDelRq', { TxnDelType: 'ReceivePayment', TxnID: p2.TxnID }));
    expect(t.rq('InvoiceQueryRq', { TxnID: inv.TxnID }).rets[0]).toMatchObject({
      BalanceRemaining: '181.19',
      IsPaid: 'false',
    });
    // Payment for another customer's invoice is refused.
    const wrong = t.rq('ReceivePaymentAddRq', {
      CustomerRef: ref('Other Co'),
      TotalAmount: 5,
      AppliedToTxnAdd: [{ TxnID: inv.TxnID, PaymentAmount: 5 }],
    });
    expect(wrong.statusCode).toBe(3180);
    // Missing invoice.
    expect(
      t.rq('ReceivePaymentAddRq', {
        CustomerRef: ref('Acme'),
        TotalAmount: 5,
        AppliedToTxnAdd: [{ TxnID: 'FFFF-1', PaymentAmount: 5 }],
      }).statusCode,
    ).toBe(3120);
  });

  it('modifies lines (TxnLineID -1 adds, existing ids update, omitted lines are removed)', () => {
    const t = company();
    const inv = invoice(t);
    const [l1, l2] = inv.InvoiceLineRet as Record<string, string>[];
    t.advance(5000);
    const mod = ret(
      t.rq('InvoiceModRq', {
        TxnID: inv.TxnID,
        EditSequence: inv.EditSequence,
        Memo: 'Updated',
        InvoiceLineMod: [
          { TxnLineID: l1!.TxnLineID, Quantity: 3 },
          { TxnLineID: '-1', ItemRef: ref('Filter'), Quantity: 1 },
        ],
      }),
    );
    const lines = mod.InvoiceLineRet as Record<string, string>[];
    expect(lines.map((l) => [l.TxnLineID === l1!.TxnLineID, l.Amount])).toEqual([
      [true, '300.00'],
      [false, '20.00'],
    ]);
    expect(lines.some((l) => l.TxnLineID === l2!.TxnLineID)).toBe(false);
    expect(mod).toMatchObject({
      Memo: 'Updated',
      Subtotal: '320.00',
      SalesTaxTotal: '1.65',
      BalanceRemaining: '321.65',
      RefNumber: '1001',
    });
    const stale = t.rq('InvoiceModRq', {
      TxnID: inv.TxnID,
      EditSequence: inv.EditSequence,
      Memo: 'x',
    });
    expect(stale.statusCode).toBe(3200);
    const badLine = t.rq('InvoiceModRq', {
      TxnID: inv.TxnID,
      EditSequence: mod.EditSequence,
      InvoiceLineMod: [{ TxnLineID: '999-1', Quantity: 1 }],
    });
    expect(badLine.statusCode).toBe(3120);
    // Header-only Mod keeps the lines.
    const keep = ret(
      t.rq('InvoiceModRq', { TxnID: inv.TxnID, EditSequence: mod.EditSequence, PONumber: 'PO-1' }),
    );
    expect(keep.InvoiceLineRet).toHaveLength(2);
  });

  it('voids and deletes transactions, logging deletes for TxnDeletedQuery', () => {
    const t = company();
    const inv = invoice(t, { Memo: 'Spring service' });
    t.advance(2000);
    const v = ok(t.rq('TxnVoidRq', { TxnVoidType: 'Invoice', TxnID: inv.TxnID }));
    expect(v.body).toMatchObject({ TxnVoidType: 'Invoice', TxnID: inv.TxnID, RefNumber: '1001' });
    const voided = t.rq('InvoiceQueryRq', { TxnID: inv.TxnID, IncludeLineItems: true }).rets[0]!;
    expect(voided).toMatchObject({
      Memo: 'VOID: Spring service',
      Subtotal: '0.00',
      SalesTaxTotal: '0.00',
      BalanceRemaining: '0.00',
    });
    expect(
      (voided.InvoiceLineRet as Record<string, string>[]).every((l) => l.Amount === '0.00'),
    ).toBe(true);
    const inv2 = invoice(t);
    ok(t.rq('TxnDelRq', { TxnDelType: 'Invoice', TxnID: inv2.TxnID }));
    expect(t.rq('InvoiceQueryRq', { TxnID: inv2.TxnID }).statusCode).toBe(500);
    expect(t.rq('TxnDelRq', { TxnDelType: 'Invoice', TxnID: inv2.TxnID }).statusCode).toBe(3120);
    const del = t.rq('TxnDeletedQueryRq', { TxnDelType: ['Invoice', 'Bill'] });
    expect(del.rets).toEqual([
      {
        TxnDelType: 'Invoice',
        TxnID: inv2.TxnID,
        TimeCreated: inv2.TimeCreated,
        TimeDeleted: expect.any(String),
        RefNumber: '1002',
      },
    ]);
  });

  it('bills, bill payments and expense totals', () => {
    const t = company();
    const bill = ret(
      t.rq('BillAddRq', {
        VendorRef: ref('Supply Co'),
        TxnDate: '2026-04-01',
        RefNumber: 'S-1',
        ExpenseLineAdd: [{ AccountRef: ref('Rent'), Amount: 1200 }],
        ItemLineAdd: [{ ItemRef: ref('Filter'), Quantity: 10 }],
      }),
    );
    expect(bill).toMatchObject({
      AmountDue: '1280.00',
      OpenAmount: '1280.00',
      IsPaid: 'false',
      APAccountRef: { FullName: 'Accounts Payable' },
    });
    expect((bill.ItemLineRet as Record<string, string>[])[0]).toMatchObject({
      Cost: '8',
      Amount: '80.00',
    });
    const pay = ret(
      t.rq('BillPaymentCheckAddRq', {
        PayeeEntityRef: ref('Supply Co'),
        BankAccountRef: ref('Checking'),
        RefNumber: '1001',
        AppliedToTxnAdd: [{ TxnID: bill.TxnID, PaymentAmount: 1280 }],
      }),
    );
    expect(pay).toMatchObject({
      Amount: '1280.00',
      AppliedToTxnRet: [
        { TxnID: bill.TxnID, TxnType: 'Bill', Amount: '1280.00', BalanceRemaining: '0.00' },
      ],
    });
    expect(t.rq('BillQueryRq', { TxnID: bill.TxnID }).rets[0]).toMatchObject({
      OpenAmount: '0.00',
      IsPaid: 'true',
    });
    const check = ret(
      t.rq('CheckAddRq', {
        AccountRef: ref('Checking'),
        PayeeEntityRef: ref('Supply Co'),
        ExpenseLineAdd: [
          { AccountRef: ref('Rent'), Amount: 10 },
          { AccountRef: ref('Rent'), Amount: 5.5 },
        ],
      }),
    );
    expect(check.Amount).toBe('15.50');
    const je = t.rq('JournalEntryAddRq', {
      JournalDebitLine: [{ AccountRef: ref('Rent'), Amount: 10 }],
      JournalCreditLine: [{ AccountRef: ref('Checking'), Amount: 9 }],
    });
    expect(je.statusCode).toBe(3180);
    expect(je.statusMessage).toContain('not in balance');
    const good = ret(
      t.rq('JournalEntryAddRq', {
        JournalDebitLine: [{ AccountRef: ref('Rent'), Amount: 10 }],
        JournalCreditLine: [{ AccountRef: ref('Checking'), Amount: 10 }],
      }),
    );
    const [dr] = good.JournalDebitLine as Record<string, string>[];
    const [cr] = good.JournalCreditLine as Record<string, string>[];
    const unbalanced = t.rq('JournalEntryModRq', {
      TxnID: good.TxnID,
      EditSequence: good.EditSequence,
      JournalLineMod: [
        { TxnLineID: dr!.TxnLineID, Amount: 12 },
        { TxnLineID: cr!.TxnLineID, Amount: 10 },
      ],
    });
    expect(unbalanced.statusCode).toBe(3180);
    const modded = ret(
      t.rq('JournalEntryModRq', {
        TxnID: good.TxnID,
        EditSequence: good.EditSequence,
        JournalLineMod: [
          { TxnLineID: dr!.TxnLineID, Amount: 12 },
          { TxnLineID: cr!.TxnLineID, Amount: 10 },
          { TxnLineID: '-1', JournalLineType: 'Credit', AccountRef: ref('Checking'), Amount: 2 },
        ],
      }),
    );
    expect((modded.JournalDebitLine as Record<string, string>[]).map((l) => l.Amount)).toEqual([
      '12.00',
    ]);
    expect((modded.JournalCreditLine as Record<string, string>[]).map((l) => l.Amount)).toEqual([
      '10.00',
      '2.00',
    ]);
  });

  it('deposits undeposited payments', () => {
    const t = company();
    const inv = invoice(t);
    const pay = ret(
      t.rq('ReceivePaymentAddRq', {
        CustomerRef: ref('Acme'),
        TotalAmount: 50,
        AppliedToTxnAdd: [{ TxnID: inv.TxnID, PaymentAmount: 50 }],
      }),
    );
    expect(t.rq('ReceivePaymentToDepositQueryRq', {}).rets).toEqual([
      {
        TxnID: pay.TxnID,
        TxnType: 'ReceivePayment',
        CustomerRef: { ListID: expect.any(String), FullName: 'Acme' },
        TxnDate: pay.TxnDate,
        Amount: '50.00',
      },
    ]);
    const dep = ret(
      t.rq('DepositAddRq', {
        DepositToAccountRef: ref('Checking'),
        DepositLineAdd: [{ PaymentTxnID: pay.TxnID }],
      }),
    );
    expect(dep).toMatchObject({
      DepositTotal: '50.00',
      DepositLineRet: [
        {
          TxnID: pay.TxnID,
          TxnType: 'ReceivePayment',
          Amount: '50.00',
          AccountRef: { FullName: 'Undeposited Funds' },
        },
      ],
    });
    expect(t.rq('ReceivePaymentToDepositQueryRq', {}).statusCode).toBe(1);
  });

  it('expands item groups', () => {
    const t = company();
    ok(
      t.rq('ItemGroupAddRq', {
        Name: 'Kit',
        IsPrintItemsInGroup: true,
        ItemGroupLine: [
          { ItemRef: ref('Labor'), Quantity: 1 },
          { ItemRef: ref('Filter'), Quantity: 2 },
        ],
      }),
    );
    const inv = ret(
      t.rq('InvoiceAddRq', {
        CustomerRef: ref('Acme'),
        InvoiceLineGroupAdd: [{ ItemGroupRef: ref('Kit'), Quantity: 2 }],
      }),
    );
    const g = (inv.InvoiceLineGroupRet as Record<string, unknown>[])[0]!;
    expect(g).toMatchObject({ IsPrintItemsInGroup: 'true', TotalAmount: '280.00' });
    expect(
      (g.InvoiceLineRet as Record<string, string>[]).map((l) => [l.Quantity, l.Amount]),
    ).toEqual([
      ['2', '200.00'],
      ['4', '80.00'],
    ]);
    expect(inv).toMatchObject({ Subtotal: '280.00', SalesTaxTotal: '6.60' });
  });

  it('TransactionQuery summarises every transaction type', () => {
    const t = company();
    invoice(t);
    ok(
      t.rq('CheckAddRq', {
        AccountRef: ref('Checking'),
        TxnDate: '2026-04-11',
        ExpenseLineAdd: [{ AccountRef: ref('Rent'), Amount: 10 }],
      }),
    );
    const all = t.rq('TransactionQueryRq', {});
    expect(all.rets.map((r) => r.TxnType).sort()).toEqual(['Check', 'Invoice']);
    expect(all.rets.find((r) => r.TxnType === 'Invoice')).toMatchObject({
      Amount: '281.19',
      EntityRef: { FullName: 'Acme' },
    });
    expect(
      t.rq('TransactionQueryRq', { TransactionTypeFilter: { TxnTypeFilter: 'Check' } }).rets,
    ).toHaveLength(1);
  });
});

describe('batches', () => {
  it('echoes requestIDs and honours stopOnError / continueOnError / rollbackOnError', () => {
    const t = company();
    const parts = [
      { rq: 'ClassAddRq', body: { Name: 'One' }, opts: { requestID: 'a' } },
      { rq: 'ClassAddRq', body: { Name: 'One' }, opts: { requestID: 'b' } },
      { rq: 'ClassAddRq', body: { Name: 'Two' }, opts: { requestID: 'c' } },
    ];
    const stop = t.batch(parts, 'stopOnError');
    expect(stop.map((r) => [r.requestID, r.statusCode])).toEqual([
      ['a', 0],
      ['b', 3100],
    ]);
    const t2 = company();
    const cont = t2.batch(parts, 'continueOnError');
    expect(cont.map((r) => [r.requestID, r.statusCode])).toEqual([
      ['a', 0],
      ['b', 3100],
      ['c', 0],
    ]);
    const t3 = company();
    const rb = t3.batch(parts, 'rollbackOnError');
    expect(rb.map((r) => r.statusCode)).toEqual([0, 3100]);
    expect(t3.rq('ClassQueryRq', {}).statusCode).toBe(1);
  });

  it('a failed request leaves no partial changes', () => {
    const t = company();
    const before = t.engine.store.snapshot();
    const r = t.rq('InvoiceAddRq', {
      CustomerRef: ref('Acme'),
      InvoiceLineAdd: [{ ItemRef: ref('Labor') }, { ItemRef: ref('Nope') }],
    });
    expect(r.statusCode).toBe(3140);
    expect(t.engine.store.snapshot()).toEqual(before);
  });
});
