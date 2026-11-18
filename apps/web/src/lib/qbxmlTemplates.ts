/**
 * Starting points for the raw qbXML console. Each is checked against the XSD
 * in the test suite.
 */
export interface QbxmlTemplate {
  name: string;
  xml: string;
}

const wrap = (body: string, onError = 'stopOnError') =>
  `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRq onError="${onError}">
${body
  .trim()
  .split('\n')
  .map((l) => `    ${l}`)
  .join('\n')}
  </QBXMLMsgsRq>
</QBXML>
`;

export const QBXML_TEMPLATES: QbxmlTemplate[] = [
  {
    name: 'Company info',
    xml: wrap(`<CompanyQueryRq requestID="1" />`),
  },
  {
    name: 'Host info',
    xml: wrap(`<HostQueryRq requestID="1" />`),
  },
  {
    name: 'Customers (first 10, active)',
    xml: wrap(`<CustomerQueryRq requestID="1">
  <MaxReturned>10</MaxReturned>
  <ActiveStatus>ActiveOnly</ActiveStatus>
</CustomerQueryRq>`),
  },
  {
    name: 'Customer by name',
    xml: wrap(`<CustomerQueryRq requestID="1">
  <FullName>Acme Corp</FullName>
</CustomerQueryRq>`),
  },
  {
    name: 'Invoices in a date range, with lines',
    xml: wrap(`<InvoiceQueryRq requestID="1">
  <MaxReturned>25</MaxReturned>
  <TxnDateRangeFilter>
    <FromTxnDate>2026-01-01</FromTxnDate>
    <ToTxnDate>2026-12-31</ToTxnDate>
  </TxnDateRangeFilter>
  <IncludeLineItems>true</IncludeLineItems>
</InvoiceQueryRq>`),
  },
  {
    name: 'Items (names and types)',
    xml: wrap(`<ItemQueryRq requestID="1">
  <MaxReturned>50</MaxReturned>
  <IncludeRetElement>ListID</IncludeRetElement>
  <IncludeRetElement>FullName</IncludeRetElement>
</ItemQueryRq>`),
  },
  {
    name: 'Chart of accounts',
    xml: wrap(`<AccountQueryRq requestID="1">
  <ActiveStatus>All</ActiveStatus>
</AccountQueryRq>`),
  },
  {
    name: 'Profit and loss, this year',
    xml: wrap(`<GeneralSummaryReportQueryRq requestID="1">
  <GeneralSummaryReportType>ProfitAndLossStandard</GeneralSummaryReportType>
  <ReportPeriod>
    <FromReportDate>2026-01-01</FromReportDate>
    <ToReportDate>2026-12-31</ToReportDate>
  </ReportPeriod>
</GeneralSummaryReportQueryRq>`),
  },
  {
    name: 'Add a customer',
    xml: wrap(`<CustomerAddRq requestID="1">
  <CustomerAdd>
    <Name>New Customer</Name>
    <CompanyName>New Customer Inc.</CompanyName>
    <BillAddress>
      <Addr1>1 Main St</Addr1>
      <City>Springfield</City>
      <State>IL</State>
      <PostalCode>62701</PostalCode>
    </BillAddress>
    <Phone>555-0100</Phone>
  </CustomerAdd>
</CustomerAddRq>`),
  },
];
