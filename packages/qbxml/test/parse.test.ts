import { describe, expect, it } from 'vitest';
import {
  buildResponse,
  catalog,
  editSequenceOf,
  idOf,
  isOk,
  minimalObject,
  parseResponse,
  QbxmlParseError,
} from '../src/index.js';
import { expectValid } from './helpers.js';

const customerQuery = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK" retCount="2" iteratorRemainingCount="148" iteratorID="{eb05f701-e727-472f-8ade-6753c4f67a46}">
<CustomerRet>
<ListID>80000001-1700000000</ListID>
<TimeCreated>2024-01-02T09:15:00-08:00</TimeCreated>
<TimeModified>2024-03-04T11:22:33-08:00</TimeModified>
<EditSequence>1709580153</EditSequence>
<Name>Acme &amp; Sons</Name>
<FullName>Acme &amp; Sons</FullName>
<IsActive>true</IsActive>
<Sublevel>0</Sublevel>
<CompanyName>Acme &amp; Sons, Inc.</CompanyName>
<BillAddress>
<Addr1>742 Evergreen Terrace</Addr1>
<City>Springfield</City>
</BillAddress>
<Phone>555-0100</Phone>
<Balance>1559.97</Balance>
<TotalBalance>1559.97</TotalBalance>
<JobStatus>None</JobStatus>
<DataExtRet>
<DataExtName>Region</DataExtName>
<DataExtType>STR255TYPE</DataExtType>
<DataExtValue>Midwest</DataExtValue>
</DataExtRet>
</CustomerRet>
<CustomerRet>
<ListID>80000002-1700000001</ListID>
<TimeCreated>2024-01-03T09:15:00-08:00</TimeCreated>
<TimeModified>2024-01-03T09:15:00-08:00</TimeModified>
<EditSequence>1704302100</EditSequence>
<Name>Caf&#233; Lumi&#xE8;re</Name>
<FullName>Caf&#233; Lumi&#xE8;re</FullName>
<IsActive>false</IsActive>
<Sublevel>0</Sublevel>
<Balance>0.00</Balance>
<TotalBalance>0.00</TotalBalance>
<JobStatus>None</JobStatus>
</CustomerRet>
</CustomerQueryRs>
</QBXMLMsgsRs>
</QBXML>
`;

const invoiceQuery = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<InvoiceQueryRs requestID="7" statusCode="0" statusSeverity="Info" statusMessage="Status OK">
<InvoiceRet>
<TxnID>1A2B-1700000000</TxnID>
<TimeCreated>2024-01-15T10:00:00-08:00</TimeCreated>
<TimeModified>2024-01-15T10:00:00-08:00</TimeModified>
<EditSequence>1705341600</EditSequence>
<TxnNumber>42</TxnNumber>
<CustomerRef>
<ListID>80000001-1700000000</ListID>
<FullName>Acme &amp; Sons</FullName>
</CustomerRef>
<ARAccountRef>
<FullName>Accounts Receivable</FullName>
</ARAccountRef>
<TxnDate>2024-01-15</TxnDate>
<RefNumber>INV-1001</RefNumber>
<IsPending>false</IsPending>
<IsFinanceCharge>false</IsFinanceCharge>
<DueDate>2024-02-14</DueDate>
<ShipDate>2024-01-15</ShipDate>
<Subtotal>1500.00</Subtotal>
<SalesTaxPercentage>0.00</SalesTaxPercentage>
<SalesTaxTotal>0.00</SalesTaxTotal>
<AppliedAmount>0.00</AppliedAmount>
<BalanceRemaining>1500.00</BalanceRemaining>
<Memo>  leading and trailing spaces  </Memo>
<IsPaid>false</IsPaid>
<IsToBePrinted>true</IsToBePrinted>
<IsToBeEmailed>false</IsToBeEmailed>
<InvoiceLineRet>
<TxnLineID>1A2C-1700000000</TxnLineID>
<ItemRef>
<FullName>Consulting</FullName>
</ItemRef>
<Desc>January consulting</Desc>
<Quantity>10</Quantity>
<Rate>150.00</Rate>
<Amount>1500.00</Amount>
</InvoiceLineRet>
</InvoiceRet>
</InvoiceQueryRs>
</QBXMLMsgsRs>
</QBXML>
`;

describe('parseResponse', () => {
  it('parses a list query with iterator attributes and many rets', () => {
    expectValid(customerQuery);
    const [rs] = parseResponse(customerQuery);
    expect(rs).toMatchObject({
      name: 'CustomerQueryRs',
      requestID: '1',
      statusCode: 0,
      statusSeverity: 'Info',
      statusMessage: 'Status OK',
      retName: 'CustomerRet',
      retCount: 2,
      iteratorID: '{eb05f701-e727-472f-8ade-6753c4f67a46}',
      iteratorRemainingCount: 148,
    });
    expect(rs!.rets).toHaveLength(2);
    const [a, b] = rs!.rets as Record<string, unknown>[];
    expect(a).toMatchObject({
      ListID: '80000001-1700000000',
      Name: 'Acme & Sons',
      IsActive: 'true',
      Balance: '1559.97',
      BillAddress: { Addr1: '742 Evergreen Terrace', City: 'Springfield' },
    });
    // DataExtRet is maxOccurs=unbounded: array even with one element
    expect(a!.DataExtRet).toEqual([
      { DataExtName: 'Region', DataExtType: 'STR255TYPE', DataExtValue: 'Midwest' },
    ]);
    expect(b!.Name).toBe('Café Lumière');
    expect(idOf('Customer', a!)).toBe('80000001-1700000000');
    expect(editSequenceOf(a!)).toBe('1709580153');
    expect(isOk(rs!)).toBe(true);
    expect(rs!.raw.startsWith('<CustomerQueryRs requestID="1"')).toBe(true);
    expect(rs!.raw.endsWith('</CustomerQueryRs>')).toBe(true);
  });

  it('makes repeated elements arrays even with one occurrence, keeps values lossless', () => {
    expectValid(invoiceQuery);
    const [rs] = parseResponse(invoiceQuery);
    expect(rs!.rets).toHaveLength(1);
    const inv = rs!.rets[0]!;
    expect(Array.isArray(inv.InvoiceLineRet)).toBe(true);
    expect(inv.InvoiceLineRet).toEqual([
      {
        TxnLineID: '1A2C-1700000000',
        ItemRef: { FullName: 'Consulting' },
        Desc: 'January consulting',
        Quantity: '10',
        Rate: '150.00',
        Amount: '1500.00',
      },
    ]);
    expect(inv.CustomerRef).toEqual({ ListID: '80000001-1700000000', FullName: 'Acme & Sons' });
    expect(inv.Memo).toBe('  leading and trailing spaces  ');
    expect(inv.Subtotal).toBe('1500.00');
    expect(idOf('Invoice', inv)).toBe('1A2B-1700000000');
  });

  it('parses error responses: 3100, 3200, 500 and info 1', () => {
    const xml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<CustomerAddRs requestID="0" statusCode="3100" statusSeverity="Error" statusMessage="The name &quot;Acme &amp; Sons&quot; of the list element is already in use." />
<CustomerModRs requestID="1" statusCode="3200" statusSeverity="Error" statusMessage="The provided edit sequence &quot;1709580100&quot; is out-of-date. " />
<InvoiceQueryRs requestID="2" statusCode="500" statusSeverity="Warn" statusMessage="The query request has not been fully completed. There was a required element (&quot;9999-1&quot;) that could not be found in QuickBooks.">
<InvoiceRet>
<TxnID>1A2B-1700000000</TxnID>
<TimeCreated>2024-01-15T10:00:00-08:00</TimeCreated>
<TimeModified>2024-01-15T10:00:00-08:00</TimeModified>
<EditSequence>1705341600</EditSequence>
<CustomerRef><FullName>Acme</FullName></CustomerRef>
<TxnDate>2024-01-15</TxnDate>
</InvoiceRet>
</InvoiceQueryRs>
<BillQueryRs requestID="3" statusCode="1" statusSeverity="Info" statusMessage="A query request did not find a matching object in QuickBooks" />
</QBXMLMsgsRs>
</QBXML>`;
    expectValid(xml);
    const rs = parseResponse(xml);
    expect(rs.map((r) => [r.name, r.requestID, r.statusCode, r.statusSeverity])).toEqual([
      ['CustomerAddRs', '0', 3100, 'Error'],
      ['CustomerModRs', '1', 3200, 'Error'],
      ['InvoiceQueryRs', '2', 500, 'Warn'],
      ['BillQueryRs', '3', 1, 'Info'],
    ]);
    expect(rs[0]!.statusMessage).toBe(
      'The name "Acme & Sons" of the list element is already in use.',
    );
    expect(rs[0]!.rets).toEqual([]);
    expect(rs[0]!.retName).toBe('CustomerRet');
    expect(rs[2]!.rets).toHaveLength(1);
    expect(rs.map(isOk)).toEqual([false, false, true, true]);
    expect(rs[1]!.raw).toBe(
      '<CustomerModRs requestID="1" statusCode="3200" statusSeverity="Error" statusMessage="The provided edit sequence &quot;1709580100&quot; is out-of-date. " />',
    );
    expect(rs[2]!.raw).toMatch(/^<InvoiceQueryRs requestID="2"[\s\S]*<\/InvoiceQueryRs>$/);
  });

  it('handles union queries (ItemQueryRs) with mixed ret types', () => {
    const xml = buildResponse([
      {
        rs: 'ItemQueryRs',
        requestID: '1',
        body: {
          ItemServiceRet: [{ ...minimalObject('ItemServiceRet'), Name: 'Consulting' }],
          ItemInventoryRet: [{ ...minimalObject('ItemInventoryRet'), Name: 'Widget' }],
        },
      },
    ]);
    expectValid(xml);
    const [rs] = parseResponse(xml);
    expect(rs!.retNames).toEqual(['ItemServiceRet', 'ItemInventoryRet']);
    expect(rs!.retName).toBeUndefined();
    expect(rs!.rets.map((r) => r.Name)).toEqual(['Consulting', 'Widget']);
  });

  it('parses report responses with attributes', () => {
    const xml = `<?xml version="1.0" ?>
<QBXML><QBXMLMsgsRs>
<GeneralSummaryReportQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK">
<ReportRet>
<ReportTitle>Profit &amp; Loss</ReportTitle>
<ReportSubtitle>January 2024</ReportSubtitle>
<ReportBasis>Accrual</ReportBasis>
<NumRows>2</NumRows>
<NumColumns>2</NumColumns>
<NumColTitleRows>1</NumColTitleRows>
<ColDesc colID="1" dataType="STRTYPE"><ColTitle titleRow="1" /><ColType>Label</ColType></ColDesc>
<ColDesc colID="2" dataType="AMTTYPE"><ColTitle titleRow="1" value="Jan 24" /><ColType>Amount</ColType></ColDesc>
<ReportData>
<DataRow rowNumber="1"><RowData rowType="account" value="Sales" /><ColData colID="1" value="Sales" /><ColData colID="2" value="1500.00" /></DataRow>
<TotalRow rowNumber="2"><ColData colID="1" value="Net Income" /><ColData colID="2" value="1500.00" /></TotalRow>
</ReportData>
</ReportRet>
</GeneralSummaryReportQueryRs>
</QBXMLMsgsRs></QBXML>`;
    expectValid(xml);
    const [rs] = parseResponse(xml);
    const rep = rs!.rets[0]!;
    expect(rep.ReportTitle).toBe('Profit & Loss');
    expect(rep.ColDesc).toHaveLength(2);
    expect((rep.ColDesc as Record<string, unknown>[])[1]).toEqual({
      '@colID': '2',
      '@dataType': 'AMTTYPE',
      ColTitle: [{ '@titleRow': '1', '@value': 'Jan 24' }],
      ColType: 'Amount',
    });
    const data = rep.ReportData as Record<string, Record<string, unknown>[]>;
    expect(data.DataRow![0]).toEqual({
      '@rowNumber': '1',
      RowData: { '@rowType': 'account', '@value': 'Sales' },
      ColData: [
        { '@colID': '1', '@value': 'Sales' },
        { '@colID': '2', '@value': '1500.00' },
      ],
    });
    expect(data.TotalRow).toHaveLength(1);
  });

  it('keeps simpleContent attributes, CDATA and entity-looking text intact', () => {
    const xml = `<QBXML><QBXMLMsgsRs><CustomerQueryRs statusCode="0" statusSeverity="Info"><CustomerRet><ListID>1</ListID><Name>A &amp;#38; B</Name><Notes><![CDATA[x < y & z]]></Notes></CustomerRet></CustomerQueryRs></QBXMLMsgsRs></QBXML>`;
    const [rs] = parseResponse(xml);
    expect(rs!.rets[0]).toMatchObject({ Name: 'A &#38; B', Notes: 'x < y & z' });
    expect(rs!.statusMessage).toBe('');
  });

  it('returns an empty list for an empty message set and rejects garbage', () => {
    expect(parseResponse('<?xml version="1.0"?><QBXML><QBXMLMsgsRs /></QBXML>')).toEqual([]);
    expect(() => parseResponse('<html><body>502 Bad Gateway</body></html>')).toThrow(
      QbxmlParseError,
    );
    expect(() => parseResponse('<QBXML><QBXMLMsgsRs><CustomerQueryRs')).toThrow(QbxmlParseError);
  });
});

describe('buildResponse + parseResponse round trip for every response type', () => {
  const rqs = Object.values(catalog.requests);
  it.each(rqs.map((r) => [r.response, r] as const))('%s', (rsName, rq) => {
    const body = minimalObject(rsName);
    if (rq.retElement && body[rq.retElement] === undefined) {
      const f = catalog.objects[rsName]!.fields.find((x) => x.name === rq.retElement)!;
      body[rq.retElement] = [minimalObject(f.children!)];
    }
    const xml = buildResponse([
      {
        rs: rsName,
        body,
        requestID: '9',
        iteratorRemainingCount: rq.supportsIterator ? 0 : undefined,
        iteratorID: rq.supportsIterator ? '{x}' : undefined,
      },
    ]);
    expectValid(xml);
    const [p] = parseResponse(xml);
    expect(p!.name).toBe(rsName);
    expect(p!.requestID).toBe('9');
    expect(p!.statusCode).toBe(0);
    if (rq.retElement && rq.retElement.endsWith('Ret')) {
      expect(p!.rets.length).toBeGreaterThanOrEqual(1);
      expect(p!.retNames[0]).toBe(rq.retElement);
    }
  });

  it('buildResponse rejects unknown responses and invalid content', () => {
    expect(() => buildResponse([{ rs: 'CustomerQeuryRs' }])).toThrow(
      /unknown response.*CustomerQueryRs/,
    );
    expect(() =>
      buildResponse([{ rs: 'CustomerQueryRs', body: { CustomerRet: [{ Balance: 'lots' }] } }]),
    ).toThrow(/XSD validation.*Balance/);
  });

  it('buildResponse sets severity from the status code', () => {
    const xml = buildResponse([
      { rs: 'CustomerModRs', statusCode: 3200, statusMessage: 'out-of-date' },
      { rs: 'BillQueryRs', statusCode: 1 },
    ]);
    expectValid(xml);
    const rs = parseResponse(xml);
    expect(rs[0]).toMatchObject({
      statusCode: 3200,
      statusSeverity: 'Error',
      statusMessage: 'out-of-date',
    });
    expect(rs[1]).toMatchObject({ statusCode: 1, statusSeverity: 'Warn' });
  });
});
