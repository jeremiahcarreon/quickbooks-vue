import { catalog } from '@qbv/qbxml';
import { upsertObjects, type Db } from '@qbv/db';

type Ret = Record<string, unknown>;

const ts = (d: string) => `${d}T09:00:00-05:00`;
let seq = 0;
const base = (id: string, date: string): Ret => ({
  TxnID: id,
  TimeCreated: ts(date),
  TimeModified: ts(date),
  EditSequence: String(++seq),
  TxnDate: date,
});
const ref = (id: string, name: string) => ({ ListID: id, FullName: name });
const line = (itemId: string, item: string, qty: string, amount: string) => ({
  TxnLineID: `L${++seq}`,
  ItemRef: ref(itemId, item),
  Quantity: qty,
  Amount: amount,
});

const ACME = ref('C1', 'Acme');
const JOB = ref('C3', 'Beta:Job1');
const CASH = ref('C5', 'Cash Cust');
const PAPER = ref('V1', 'Paper Co');
const RENT = ref('V2', 'Rent LLC');

export const FIXTURES: Record<string, Ret[]> = {
  Customer: [
    {
      ListID: 'C1',
      Name: 'Acme',
      FullName: 'Acme',
      IsActive: 'true',
      Sublevel: '0',
      Balance: '1050.00',
      TotalBalance: '1050.00',
    },
    {
      ListID: 'C2',
      Name: 'Beta',
      FullName: 'Beta',
      IsActive: 'true',
      Sublevel: '0',
      Balance: '0.00',
      TotalBalance: '300.00',
    },
    {
      ListID: 'C3',
      Name: 'Job1',
      FullName: 'Beta:Job1',
      IsActive: 'true',
      Sublevel: '1',
      Balance: '300.00',
      TotalBalance: '300.00',
    },
    {
      ListID: 'C4',
      Name: 'Zero Co',
      FullName: 'Zero Co',
      IsActive: 'true',
      Sublevel: '0',
      Balance: '0.00',
      TotalBalance: '0.00',
    },
    {
      ListID: 'C5',
      Name: 'Cash Cust',
      FullName: 'Cash Cust',
      IsActive: 'true',
      Sublevel: '0',
      Balance: '0.00',
      TotalBalance: '0.00',
    },
  ],
  Vendor: [
    { ListID: 'V1', Name: 'Paper Co', IsActive: 'true', Balance: '250.00' },
    { ListID: 'V2', Name: 'Rent LLC', IsActive: 'true', Balance: '1000.00' },
    { ListID: 'V3', Name: 'Old Vendor', IsActive: 'false', Balance: '0.00' },
  ],
  ItemInventory: [
    {
      ListID: 'I1',
      Name: 'Widget',
      FullName: 'Widget',
      IsActive: 'true',
      Sublevel: '0',
      SalesDesc: 'A widget',
      SalesPrice: '50.00',
      QuantityOnHand: '10',
      AverageCost: '20.00',
    },
    {
      ListID: 'I2',
      Name: 'Gadget',
      FullName: 'Parts:Gadget',
      IsActive: 'true',
      Sublevel: '1',
      PurchaseDesc: 'Gadget bought',
      SalesPrice: '30.00',
      QuantityOnHand: '5',
      AverageCost: '10.00',
    },
    {
      ListID: 'I3',
      Name: 'Retired',
      FullName: 'Retired',
      IsActive: 'false',
      Sublevel: '0',
      SalesPrice: '1.00',
      QuantityOnHand: '1',
      AverageCost: '1.00',
    },
  ],
  ItemInventoryAssembly: [
    {
      ListID: 'I4',
      Name: 'Kit',
      FullName: 'Kit',
      IsActive: 'true',
      Sublevel: '0',
      QuantityOnHand: '2',
      AverageCost: '25.00',
    },
  ],
  ItemService: [{ ListID: 'S1', Name: 'Service', FullName: 'Service', IsActive: 'true' }],
  Invoice: [
    {
      ...base('T-INV1', '2024-01-01'),
      CustomerRef: ACME,
      RefNumber: 'INV-1',
      DueDate: '2024-01-31',
      TermsRef: { FullName: 'Net 30' },
      Subtotal: '1000.00',
      SalesTaxTotal: '0.00',
      AppliedAmount: '-400.00',
      BalanceRemaining: '600.00',
      IsPaid: 'false',
      IsPending: 'false',
      InvoiceLineRet: [line('I1', 'Widget', '10', '500.00'), line('S1', 'Service', '5', '500.00')],
    },
    {
      ...base('T-INV2', '2024-03-20'),
      CustomerRef: ACME,
      RefNumber: 'INV-2',
      DueDate: '2024-04-19',
      Subtotal: '500.00',
      SalesTaxTotal: '0.00',
      BalanceRemaining: '500.00',
      IsPaid: 'false',
      Memo: 'March work',
      InvoiceLineRet: [line('S1', 'Service', '4', '400.00')],
      InvoiceLineGroupRet: [
        {
          TxnLineID: 'G1',
          ItemGroupRef: { FullName: 'Bundle' },
          InvoiceLineRet: [line('I1', 'Widget', '2', '100.00')],
        },
      ],
    },
    {
      ...base('T-INV3', '2023-12-01'),
      CustomerRef: JOB,
      RefNumber: 'INV-3',
      DueDate: '2023-12-01',
      Subtotal: '300.00',
      SalesTaxTotal: '0.00',
      BalanceRemaining: '300.00',
      IsPaid: 'false',
      InvoiceLineRet: [line('S1', 'Service', '3', '300.00')],
    },
    {
      ...base('T-INV4', '2024-02-01'),
      CustomerRef: ACME,
      RefNumber: 'INV-4',
      DueDate: '2024-03-02',
      Subtotal: '200.00',
      SalesTaxTotal: '0.00',
      BalanceRemaining: '0.00',
      IsPaid: 'true',
      InvoiceLineRet: [line('I1', 'Widget', '4', '200.00')],
    },
    {
      ...base('T-INV5', '2024-03-25'),
      CustomerRef: ACME,
      RefNumber: 'INV-5',
      DueDate: '2024-03-25',
      Subtotal: '999.00',
      SalesTaxTotal: '0.00',
      BalanceRemaining: '999.00',
      IsPaid: 'false',
      IsPending: 'true',
      InvoiceLineRet: [line('I1', 'Widget', '99', '999.00')],
    },
    {
      ...base('T-INV6', '2024-04-05'),
      CustomerRef: ACME,
      RefNumber: 'INV-6',
      DueDate: '2024-05-05',
      Subtotal: '50.00',
      SalesTaxTotal: '0.00',
      BalanceRemaining: '50.00',
      IsPaid: 'false',
      InvoiceLineRet: [line('I1', 'Widget', '1', '50.00')],
    },
  ],
  CreditMemo: [
    {
      ...base('T-CM1', '2024-03-01'),
      CustomerRef: ACME,
      RefNumber: 'CM-1',
      Subtotal: '100.00',
      SalesTaxTotal: '0.00',
      TotalAmount: '100.00',
      CreditRemaining: '100.00',
      CreditMemoLineRet: [line('I1', 'Widget', '2', '100.00')],
    },
  ],
  ReceivePayment: [
    {
      ...base('T-RP1', '2024-02-15'),
      CustomerRef: ACME,
      RefNumber: '1001',
      TotalAmount: '600.00',
      UnusedPayment: '0.00',
    },
  ],
  SalesReceipt: [
    {
      ...base('T-SR1', '2024-03-05'),
      CustomerRef: CASH,
      RefNumber: 'SR-1',
      Subtotal: '75.00',
      SalesTaxTotal: '0.00',
      TotalAmount: '75.00',
      SalesReceiptLineRet: [line('I1', 'Widget', '1', '75.00')],
    },
  ],
  SalesOrder: [
    {
      ...base('T-SO1', '2024-02-20'),
      CustomerRef: ACME,
      RefNumber: 'SO-1',
      ShipDate: '2024-04-10',
      TotalAmount: '250.00',
      IsFullyInvoiced: 'false',
      IsManuallyClosed: 'false',
      Memo: 'Rush',
    },
    {
      ...base('T-SO2', '2024-01-10'),
      CustomerRef: ACME,
      RefNumber: 'SO-2',
      TotalAmount: '90.00',
      IsFullyInvoiced: 'true',
      IsManuallyClosed: 'false',
    },
    {
      ...base('T-SO3', '2024-01-05'),
      CustomerRef: ref('C2', 'Beta'),
      RefNumber: 'SO-3',
      TotalAmount: '70.00',
      IsFullyInvoiced: 'false',
      IsManuallyClosed: 'true',
    },
  ],
  PurchaseOrder: [
    {
      ...base('T-PO1', '2024-03-15'),
      VendorRef: PAPER,
      RefNumber: 'PO-1',
      ExpectedDate: '2024-04-01',
      TotalAmount: '80.00',
      IsFullyReceived: 'false',
      IsManuallyClosed: 'false',
    },
    {
      ...base('T-PO2', '2024-02-01'),
      VendorRef: PAPER,
      RefNumber: 'PO-2',
      TotalAmount: '40.00',
      IsFullyReceived: 'true',
      IsManuallyClosed: 'false',
    },
  ],
  Bill: [
    {
      ...base('T-B1', '2024-03-01'),
      VendorRef: PAPER,
      RefNumber: 'B-1',
      DueDate: '2024-03-31',
      AmountDue: '300.00',
      OpenAmount: '300.00',
      IsPaid: 'false',
    },
    {
      ...base('T-B2', '2024-01-15'),
      VendorRef: PAPER,
      RefNumber: 'B-2',
      DueDate: '2024-02-14',
      AmountDue: '200.00',
      OpenAmount: '0.00',
      IsPaid: 'true',
    },
    {
      ...base('T-B3', '2024-02-01'),
      VendorRef: RENT,
      RefNumber: 'B-3',
      DueDate: '2024-02-01',
      AmountDue: '1000.00',
      IsPaid: 'false',
    },
  ],
  VendorCredit: [
    {
      ...base('T-VC1', '2024-03-10'),
      VendorRef: PAPER,
      RefNumber: 'VC-1',
      CreditAmount: '50.00',
      OpenAmount: '50.00',
    },
  ],
  BillPaymentCheck: [
    { ...base('T-BP1', '2024-02-10'), PayeeEntityRef: PAPER, RefNumber: '2001', Amount: '200.00' },
  ],
  Check: [
    {
      ...base('T-CK1', '2024-03-02'),
      PayeeEntityRef: RENT,
      RefNumber: '3001',
      Amount: '150.00',
      Memo: 'Deposit',
    },
    {
      ...base('T-CK2', '2024-03-03'),
      PayeeEntityRef: ref('E1', 'Pat Employee'),
      RefNumber: '3002',
      Amount: '99.00',
    },
  ],
};

export async function seedFixtures(db: Db): Promise<void> {
  for (const [type, rets] of Object.entries(FIXTURES)) {
    const entity = catalog.entities[type];
    if (!entity) throw new Error(`No catalog entity ${type}`);
    await upsertObjects(db, entity, rets);
  }
}
