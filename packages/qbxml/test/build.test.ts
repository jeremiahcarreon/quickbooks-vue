import { afterEach, describe, expect, it } from 'vitest';
import {
  buildBatch,
  buildRequest,
  catalog,
  minimalRequestBody,
  QbxmlBuildError,
  QbxmlValidationError,
} from '../src/index.js';
import { expectValid } from './helpers.js';

const allRequests = Object.values(catalog.requests);
const queryRequests = allRequests.filter((r) => r.op === 'Query');

describe('buildRequest: every request type', () => {
  it('covers more than 100 query requests', () => {
    expect(queryRequests.length).toBeGreaterThan(100);
  });

  it.each(queryRequests.map((r) => [r.name, r] as const))(
    '%s minimal request validates',
    (name, r) => {
      const xml = buildRequest(name, minimalRequestBody(name), { requestID: '1' });
      expectValid(xml);
      expect(xml).toContain(`<${name} requestID="1"`);
      if (r.supportsIterator) {
        const hasMax = catalog.objects[name]!.fields.some((f) => f.name === 'MaxReturned');
        const body = { ...minimalRequestBody(name), ...(hasMax ? { MaxReturned: 100 } : {}) };
        const it = buildRequest(name, body, { iterator: 'Start' });
        expectValid(it);
        expect(it).toContain('iterator="Start"');
        const cont = buildRequest(name, body, { iterator: 'Continue', iteratorID: '{A1B2}' });
        expectValid(cont);
        expect(cont).toContain('iteratorID="{A1B2}"');
      }
    },
  );

  it.each(allRequests.filter((r) => r.op !== 'Query').map((r) => [r.name] as const))(
    '%s minimal request validates',
    (name) => {
      expectValid(buildRequest(name, minimalRequestBody(name)));
    },
  );
});

describe('buildRequest: realistic adds', () => {
  const cases: [string, object][] = [
    [
      'CustomerAddRq',
      {
        CustomerAdd: {
          // deliberately out of schema order: the builder reorders
          Email: 'ap@acme.example',
          BillAddress: {
            State: 'IL',
            City: 'Springfield',
            Addr1: '742 Evergreen Terrace',
            PostalCode: '62704',
          },
          Name: 'Acme Corp',
          CompanyName: 'Acme Corporation',
          IsActive: true,
          Phone: '555-0100',
          FirstName: 'Wile',
          LastName: 'Coyote',
          TermsRef: { FullName: 'Net 30' },
          CreditLimit: 5000,
        },
      },
    ],
    [
      'VendorAddRq',
      {
        VendorAdd: {
          Name: 'Paper Supply Co',
          CompanyName: 'Paper Supply Company',
          VendorAddress: { Addr1: '1 Mill Rd', City: 'Scranton', State: 'PA', PostalCode: '18503' },
          IsVendorEligibleFor1099: false,
          AccountNumber: 'AC-1001',
        },
      },
    ],
    [
      'AccountAddRq',
      {
        AccountAdd: {
          Name: 'Operating Checking',
          AccountType: 'Bank',
          AccountNumber: '1000',
          Desc: 'Main operating account',
        },
      },
    ],
    [
      'ItemServiceAddRq',
      {
        ItemServiceAdd: {
          Name: 'Consulting',
          SalesOrPurchase: {
            Desc: 'Hourly consulting',
            Price: 150,
            AccountRef: { FullName: 'Services Income' },
          },
        },
      },
    ],
    [
      'ItemNonInventoryAddRq',
      {
        ItemNonInventoryAdd: {
          Name: 'Gift Wrap',
          SalesOrPurchase: { Desc: 'Gift wrapping', Price: 4.5, AccountRef: { FullName: 'Sales' } },
        },
      },
    ],
    [
      'ItemInventoryAddRq',
      {
        ItemInventoryAdd: {
          Name: 'Widget',
          SalesDesc: 'Blue widget',
          SalesPrice: 19.99,
          IncomeAccountRef: { FullName: 'Sales' },
          PurchaseDesc: 'Blue widget (wholesale)',
          PurchaseCost: 7.25,
          COGSAccountRef: { FullName: 'Cost of Goods Sold' },
          AssetAccountRef: { FullName: 'Inventory Asset' },
          ReorderPoint: 10,
          QuantityOnHand: 100,
        },
      },
    ],
    [
      'ItemOtherChargeAddRq',
      {
        ItemOtherChargeAdd: {
          Name: 'Shipping',
          SalesOrPurchase: { Price: 12, AccountRef: { FullName: 'Shipping Income' } },
        },
      },
    ],
    [
      'InvoiceAddRq',
      {
        InvoiceAdd: {
          CustomerRef: { FullName: 'Acme Corp' },
          TxnDate: new Date(Date.UTC(2024, 0, 15)),
          RefNumber: 'INV-1001',
          BillAddress: { Addr1: '742 Evergreen Terrace', City: 'Springfield' },
          TermsRef: { FullName: 'Net 30' },
          DueDate: '2024-02-14',
          Memo: 'Thanks for your business <3 & see you soon',
          InvoiceLineAdd: [
            {
              ItemRef: { FullName: 'Consulting' },
              Desc: 'January consulting',
              Quantity: 10,
              Rate: 150,
            },
            { ItemRef: { FullName: 'Widget' }, Quantity: 3, Rate: '19.99', Amount: 59.97 },
            { Desc: 'Comment line only' },
          ],
        },
      },
    ],
    [
      'BillAddRq',
      {
        BillAdd: {
          VendorRef: { FullName: 'Paper Supply Co' },
          TxnDate: '2024-01-20',
          DueDate: '2024-02-19',
          RefNumber: 'PS-9981',
          Memo: 'Paper order',
          ExpenseLineAdd: [
            { AccountRef: { FullName: 'Office Supplies' }, Amount: 120.5, Memo: 'Copy paper' },
          ],
          ItemLineAdd: [{ ItemRef: { FullName: 'Widget' }, Quantity: 50, Cost: 7.25 }],
        },
      },
    ],
    [
      'ReceivePaymentAddRq',
      {
        ReceivePaymentAdd: {
          CustomerRef: { FullName: 'Acme Corp' },
          TxnDate: '2024-02-01',
          RefNumber: '4521',
          TotalAmount: 1559.97,
          PaymentMethodRef: { FullName: 'Check' },
          DepositToAccountRef: { FullName: 'Undeposited Funds' },
          AppliedToTxnAdd: [{ TxnID: '1A2B-1700000000', PaymentAmount: 1559.97 }],
        },
      },
    ],
    [
      'ReceivePaymentAddRq',
      {
        ReceivePaymentAdd: {
          CustomerRef: { ListID: '80000001-1700000000' },
          TotalAmount: '100.00',
          IsAutoApply: true,
        },
      },
    ],
    [
      'JournalEntryAddRq',
      {
        JournalEntryAdd: {
          TxnDate: '2024-01-31',
          RefNumber: 'JE-12',
          Memo: 'Accrue January rent',
          JournalDebitLine: [
            { AccountRef: { FullName: 'Rent Expense' }, Amount: 2000, Memo: 'Rent' },
          ],
          JournalCreditLine: [{ AccountRef: { FullName: 'Accrued Liabilities' }, Amount: 2000 }],
        },
      },
    ],
    [
      'CheckAddRq',
      {
        CheckAdd: {
          AccountRef: { FullName: 'Operating Checking' },
          PayeeEntityRef: { FullName: 'Paper Supply Co' },
          RefNumber: '10023',
          TxnDate: '2024-02-03',
          Memo: 'Supplies',
          IsToBePrinted: false,
          ExpenseLineAdd: [{ AccountRef: { FullName: 'Office Supplies' }, Amount: 75 }],
        },
      },
    ],
    [
      'SalesReceiptAddRq',
      {
        SalesReceiptAdd: {
          CustomerRef: { FullName: 'Walk-in' },
          TxnDate: '2024-03-01',
          PaymentMethodRef: { FullName: 'Cash' },
          SalesReceiptLineAdd: [{ ItemRef: { FullName: 'Widget' }, Quantity: 1, Rate: 19.99 }],
        },
      },
    ],
  ];

  it.each(cases.map(([rq, body], i) => [`${rq} #${i}`, rq, body] as const))(
    '%s validates',
    (_label, rq, body) => {
      const xml = buildRequest(rq, body, { requestID: 'r1' });
      expectValid(xml);
    },
  );

  it('writes the Invoice in schema order with every line as its own element', () => {
    const xml = buildRequest('InvoiceAddRq', cases.find(([rq]) => rq === 'InvoiceAddRq')![1]);
    const order = [
      'CustomerRef',
      'TxnDate',
      'RefNumber',
      'BillAddress',
      'TermsRef',
      'DueDate',
      'Memo',
      'InvoiceLineAdd',
    ];
    const idx = order.map((t) => xml.indexOf(`<${t}>`));
    expect(idx.every((v, i) => v > 0 && (i === 0 || v > idx[i - 1]!))).toBe(true);
    expect(xml.match(/<InvoiceLineAdd>/g)).toHaveLength(3);
    expect(xml).toContain('<TxnDate>2024-01-15</TxnDate>');
    expect(xml).toContain('<Quantity>10</Quantity>');
    expect(xml).toContain('<Rate>150</Rate>');
    expect(xml).toContain('<Amount>59.97</Amount>');
    expect(xml).toContain('<Memo>Thanks for your business &lt;3 &amp; see you soon</Memo>');
  });

  it('formats JS numbers and booleans per base type', () => {
    const xml = buildRequest('CustomerAddRq', { Name: 'N', IsActive: false, CreditLimit: 1234.5 });
    expect(xml).toContain('<IsActive>false</IsActive>');
    expect(xml).toContain('<CreditLimit>1234.50</CreditLimit>');
  });
});

describe('buildRequest: envelope and options', () => {
  afterEach(() => {
    delete process.env.QBXML_VERSION;
  });

  it('emits the qbxml header, onError and requestID', () => {
    const xml = buildRequest(
      'CustomerQueryRq',
      { MaxReturned: 5 },
      { requestID: 'abc', onError: 'continueOnError' },
    );
    expect(
      xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<?qbxml version="16.0"?>\n<QBXML>'),
    ).toBe(true);
    expect(xml).toContain('<QBXMLMsgsRq onError="continueOnError">');
    expect(xml).toContain('<CustomerQueryRq requestID="abc">');
    expectValid(xml);
  });

  it('uses QBXML_VERSION or the version option', () => {
    process.env.QBXML_VERSION = '13.0';
    expect(buildRequest('HostQueryRq')).toContain('<?qbxml version="13.0"?>');
    expect(buildRequest('HostQueryRq', {}, { version: '17.0' })).toContain(
      '<?qbxml version="17.0"?>',
    );
  });

  it('wraps a bare Add/Mod body in its body element', () => {
    const a = buildRequest('CustomerAddRq', {
      Name: 'Bare',
      IncludeRetElement: ['ListID', 'EditSequence'],
    });
    expect(a).toMatch(
      /<CustomerAdd>\s*<Name>Bare<\/Name>\s*<\/CustomerAdd>\s*<IncludeRetElement>ListID<\/IncludeRetElement>/,
    );
    expectValid(a);
    const m = buildRequest('CustomerModRq', {
      ListID: '80000001-1',
      EditSequence: '1700000000',
      Phone: '555',
    });
    expect(m).toMatch(/<CustomerMod>\s*<ListID>/);
    expectValid(m);
  });

  it('escapes attribute and text content', () => {
    const xml = buildRequest(
      'CustomerQueryRq',
      { FullName: ['A & "B" <C>', "O'Brien"] },
      { requestID: '"x"&<' },
    );
    expect(xml).toContain('requestID="&quot;x&quot;&amp;&lt;"');
    expect(xml).toContain('<FullName>A &amp; &quot;B&quot; &lt;C&gt;</FullName>');
    expect(xml).toContain('<FullName>O&apos;Brien</FullName>');
    expectValid(xml);
  });

  it('supports simpleContent attributes via @name / #text', () => {
    const xml = buildRequest('ReceivePaymentAddRq', {
      ReceivePaymentAdd: {
        CustomerRef: { FullName: 'Acme' },
        AppliedToTxnAdd: [
          { TxnID: { '#text': '1-1', '@useMacro': 'TxnID:inv1' }, PaymentAmount: '1.00' },
        ],
      },
    });
    expect(xml).toContain('<TxnID useMacro="TxnID:inv1">1-1</TxnID>');
    expectValid(xml);
  });

  it('del and void requests', () => {
    expectValid(buildRequest('ListDelRq', { ListDelType: 'Customer', ListID: '80000001-1' }));
    expectValid(buildRequest('TxnDelRq', { TxnDelType: 'Invoice', TxnID: '1-1' }));
    expectValid(buildRequest('TxnVoidRq', { TxnVoidType: 'Check', TxnID: '1-1' }));
  });

  it('modified-date sync queries for lists and transactions', () => {
    const since = new Date('2024-01-15T10:00:00Z');
    expectValid(
      buildRequest(
        'CustomerQueryRq',
        { FromModifiedDate: since, MaxReturned: 500, ActiveStatus: 'All' },
        { iterator: 'Start' },
      ),
    );
    expectValid(
      buildRequest(
        'InvoiceQueryRq',
        {
          ModifiedDateRangeFilter: { FromModifiedDate: since },
          IncludeLineItems: true,
          MaxReturned: 500,
        },
        { iterator: 'Start' },
      ),
    );
    expectValid(
      buildRequest('TxnDeletedQueryRq', {
        TxnDelType: ['Invoice', 'Bill'],
        DeletedDateRangeFilter: { FromDeletedDate: since },
      }),
    );
    expectValid(buildRequest('ListDeletedQueryRq', { ListDelType: ['Customer'] }));
    expectValid(buildRequest('InvoiceQueryRq', { IncludeRetElement: ['TxnID', 'EditSequence'] }));
  });

  it('report queries', () => {
    expectValid(
      buildRequest('GeneralSummaryReportQueryRq', {
        GeneralSummaryReportType: 'ProfitAndLossStandard',
        ReportPeriod: { FromReportDate: '2024-01-01', ToReportDate: '2024-12-31' },
        SummarizeColumnsBy: 'Month',
      }),
    );
    expectValid(
      buildRequest('AgingReportQueryRq', {
        AgingReportType: 'ARAgingSummary',
        ReportDateMacro: 'Today',
      }),
    );
  });
});

describe('buildRequest: errors', () => {
  it('rejects unknown requests with a suggestion', () => {
    expect(() => buildRequest('CustomerAdRq', {})).toThrow(
      /Unknown qbXML request "CustomerAdRq"; did you mean "CustomerAddRq"/,
    );
  });

  it('rejects unknown fields with a helpful error', () => {
    try {
      buildRequest('InvoiceAddRq', {
        InvoiceAdd: { CustomerRef: { FullName: 'A' }, InvoiceLineAdd: [{ Qty: 1 }] },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QbxmlBuildError);
      expect(e).toBeInstanceOf(QbxmlValidationError);
      expect((e as Error).message).toMatch(
        /InvoiceLineAdd\[0\]: unknown field "Qty" in InvoiceLineAdd/,
      );
    }
    expect(() => buildRequest('CustomerAddRq', { Name: 'x', Emial: 'a' })).toThrow(
      /did you mean "Email"/,
    );
  });

  it('rejects unknown attributes', () => {
    expect(() => buildRequest('CustomerQueryRq', { '@foo': 'x' })).toThrow(
      /unknown attribute "foo"/,
    );
  });

  it('rejects too-long values via XSD validation (with line numbers)', () => {
    try {
      buildRequest('CustomerAddRq', { Name: 'x'.repeat(42) });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QbxmlValidationError);
      expect(e).not.toBeInstanceOf(QbxmlBuildError);
      const err = e as QbxmlValidationError;
      expect(err.errors[0]).toMatchObject({ line: 7 });
      expect(err.errors[0]!.message).toMatch(/maxLength/);
      expect(err.xml).toContain('<Name>');
    }
  });

  it('rejects missing required fields via XSD validation', () => {
    expect(() => buildRequest('InvoiceAddRq', { InvoiceAdd: { RefNumber: '1' } })).toThrow(
      QbxmlValidationError,
    );
    expect(() => buildRequest('InvoiceAddRq', { InvoiceAdd: { RefNumber: '1' } })).toThrow(
      /RefNumber.*Expected is \( CustomerRef \)/,
    );
  });

  it('rejects arrays for single-occurrence fields and objects for simple fields', () => {
    expect(() => buildRequest('CustomerAddRq', { Name: ['a', 'b'] })).toThrow(
      /Name may occur at most once/,
    );
    expect(() => buildRequest('CustomerAddRq', { Name: { first: 'a' } })).toThrow(
      /simple STRTYPE value; got an object/,
    );
    expect(() => buildRequest('InvoiceAddRq', { InvoiceAdd: { CustomerRef: 'Acme' } })).toThrow(
      /expected an object for CustomerRef/,
    );
  });

  it('rejects iterator options on requests without iterator support', () => {
    expect(() => buildRequest('HostQueryRq', {}, { iterator: 'Start' })).toThrow(
      /does not support iterators/,
    );
    expect(() => buildRequest('CustomerQueryRq', {}, { iterator: 'Continue' })).toThrow(
      /requires iteratorID/,
    );
  });

  it('rejects values that cannot be represented', () => {
    expect(() => buildRequest('CustomerAddRq', { Name: 'x', CreditLimit: Number.NaN })).toThrow(
      /not a finite number/,
    );
    expect(() => buildRequest('CustomerAddRq', { Name: 'x', IsActive: new Date() })).toThrow(
      /Cannot write Date value into a BOOLTYPE/,
    );
  });
});

describe('buildBatch', () => {
  it('builds several requests with default requestIDs and validates', () => {
    const xml = buildBatch(
      [
        { rq: 'CustomerAddRq', body: { Name: 'One' } },
        { rq: 'CustomerAddRq', body: { Name: 'Two' }, opts: { requestID: 'two' } },
        { rq: 'InvoiceQueryRq', body: { MaxReturned: 10 }, opts: { iterator: 'Start' } },
      ],
      'continueOnError',
    );
    expectValid(xml);
    expect(xml).toContain('<QBXMLMsgsRq onError="continueOnError">');
    expect(xml).toContain('<CustomerAddRq requestID="0">');
    expect(xml).toContain('<CustomerAddRq requestID="two">');
    expect(xml).toContain('<InvoiceQueryRq requestID="2" iterator="Start">');
  });

  it('accepts an options object and rejects invalid parts', () => {
    expect(buildBatch([{ rq: 'HostQueryRq' }], { version: '15.0' })).toContain('version="15.0"');
    expect(() => buildBatch([])).toThrow(/no requests/);
    expect(() => buildBatch([{ rq: 'CustomerAddRq', body: { Name: 'x'.repeat(50) } }])).toThrow(
      QbxmlValidationError,
    );
    expect(() =>
      buildBatch([{ rq: 'HostQueryRq' }, { rq: 'DataEventSubscriptionQueryRq' }]),
    ).toThrow(/cannot mix/);
  });

  it('builds subscription requests in their own message set', () => {
    const xml = buildRequest('DataEventSubscriptionQueryRq', {
      SubscriberID: '{6B063959-81B0-4B9A-8E9B-1234567890AB}',
    });
    expect(xml).toContain('<QBXMLSubscriptionMsgsRq>');
    expectValid(xml);
  });
});
