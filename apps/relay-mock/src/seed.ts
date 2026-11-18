// Deterministic sample company: a small HVAC / service business with a
// chart of accounts, items, customers, vendors, employees, terms, sales tax
// and about a year of transactions. Every object is created by sending a
// schema-validated qbXML request through the engine, exactly as a client would.
import { buildRequest, parseResponse, validate } from '@qbv/qbxml';
import { type Engine } from './engine.js';
import { addDays, localYmd, Rng, type Json } from './util.js';
import { parseRequestDoc } from './xml.js';

export interface SeedOptions {
  /** Date of the last generated transaction (YYYY-MM-DD or "today"). Default 2026-10-31. */
  anchor?: string;
  /** PRNG seed; the same seed always produces the same company. */
  seed?: number;
}

export interface SeedSummary {
  lists: number;
  transactions: number;
  anchor: string;
}

const ref = (FullName: string) => ({ FullName });

class Seeder {
  private minute = 0;
  lists = 0;
  txns = 0;
  constructor(private readonly engine: Engine) {}

  /** Move the clock to 08:00 local time on `date` plus a few minutes per call. */
  at(date: string): void {
    const [y, m, d] = date.split('-').map(Number);
    const base = new Date(y!, m! - 1, d!, 8, 0, 0).getTime();
    const t = base + (this.minute++ % 480) * 60_000;
    this.engine.clock = { now: () => new Date(t) };
  }

  run(rq: string, body: Json): Json {
    const xml = buildRequest(rq, body);
    if (!validate(xml).valid) throw new Error(`seed request ${rq} failed XSD validation`);
    const result = this.engine.processDocument(parseRequestDoc(xml));
    const [rs] = parseResponse(result.xml);
    if (!rs || rs.statusCode !== 0)
      throw new Error(`seed request ${rq} failed: ${rs?.statusCode} ${rs?.statusMessage}`);
    if (rs.rets[0]?.TxnID) this.txns++;
    else this.lists++;
    return rs.rets[0] ?? {};
  }
}

// ---------------------------------------------------------------------------
// Data

const ACCOUNTS: [number, string, string, string?, number?][] = [
  // number, name, type, parent, opening balance
  [1000, 'Checking', 'Bank', undefined, 28500],
  [1010, 'Savings', 'Bank', undefined, 45000],
  [1100, 'Accounts Receivable', 'AccountsReceivable'],
  [1200, 'Undeposited Funds', 'OtherCurrentAsset'],
  [1300, 'Inventory Asset', 'OtherCurrentAsset'],
  [1400, 'Prepaid Insurance', 'OtherCurrentAsset'],
  [1500, 'Vehicles', 'FixedAsset', undefined, 96000],
  [1510, 'Tools and Equipment', 'FixedAsset', undefined, 21500],
  [1590, 'Accumulated Depreciation', 'FixedAsset'],
  [2000, 'Accounts Payable', 'AccountsPayable'],
  [2100, 'Business Credit Card', 'CreditCard'],
  [2200, 'Sales Tax Payable', 'OtherCurrentLiability'],
  [2300, 'Payroll Liabilities', 'OtherCurrentLiability'],
  [2700, 'Vehicle Loan', 'LongTermLiability', undefined, 48000],
  [3000, 'Opening Balance Equity', 'Equity'],
  [3100, "Owner's Equity", 'Equity'],
  [3900, 'Retained Earnings', 'Equity'],
  [4000, 'Service Income', 'Income'],
  [4010, 'Repairs', 'Income', 'Service Income'],
  [4020, 'Maintenance Plans', 'Income', 'Service Income'],
  [4100, 'Installation Income', 'Income'],
  [4200, 'Equipment Sales', 'Income'],
  [4300, 'Parts Sales', 'Income'],
  [4400, 'Discounts Given', 'Income'],
  [5000, 'Cost of Goods Sold', 'CostOfGoodsSold'],
  [5100, 'Equipment Purchases', 'CostOfGoodsSold'],
  [5200, 'Subcontractors', 'CostOfGoodsSold'],
  [6000, 'Advertising and Marketing', 'Expense'],
  [6100, 'Automobile Expense', 'Expense'],
  [6110, 'Fuel', 'Expense', 'Automobile Expense'],
  [6120, 'Vehicle Repairs', 'Expense', 'Automobile Expense'],
  [6200, 'Insurance Expense', 'Expense'],
  [6300, 'Rent Expense', 'Expense'],
  [6400, 'Utilities', 'Expense'],
  [6410, 'Telephone and Internet', 'Expense'],
  [6500, 'Office Supplies', 'Expense'],
  [6600, 'Small Tools and Supplies', 'Expense'],
  [6700, 'Bank Service Charges', 'Expense'],
  [6800, 'Depreciation Expense', 'Expense'],
  [6900, 'Professional Fees', 'Expense'],
  [7000, 'Payroll Expenses', 'Expense'],
  [8000, 'Interest Income', 'OtherIncome'],
  [8100, 'Interest Expense', 'OtherExpense'],
];

const FIRST = [
  'Maria',
  'James',
  'Linda',
  'Robert',
  'Patricia',
  'Michael',
  'Jennifer',
  'David',
  'Susan',
  'Daniel',
  'Karen',
  'Thomas',
  'Nancy',
  'Kevin',
  'Laura',
  'Brian',
  'Angela',
  'Steven',
];
const LAST = [
  'Alvarez',
  'Bennett',
  'Chen',
  'Dawson',
  'Elliott',
  'Fischer',
  'Garcia',
  'Holloway',
  'Iverson',
  'Jensen',
  'Kowalski',
  'Lindqvist',
  'Moreno',
  'Nakamura',
  'Okafor',
  'Patel',
  'Quinn',
  'Reyes',
];
const STREETS = [
  'Aspen Ct',
  'Birch Ln',
  'Cedar St',
  'Dogwood Dr',
  'Elm Ave',
  'Fir Way',
  'Juniper Rd',
  'Larch Pl',
  'Maple St',
  'Oak Ridge Rd',
  'Pine Hollow',
  'Spruce Ave',
];
const COMMERCIAL: [string, string, string[]?][] = [
  ['Lakeside Dental Group', 'Commercial'],
  ['Maple Street Apartments', 'Property Manager', ['Building A', 'Building B']],
  ['Granite Peak Brewing', 'Commercial'],
  ['Hillcrest Community Church', 'Commercial'],
  ['Northgate Office Park', 'Property Manager', ['Suite 100', 'Suite 220']],
  ['Riverbend Veterinary Clinic', 'Commercial'],
  ['Summit Fitness Center', 'Commercial'],
];

interface ItemSpec {
  kind: 'ItemService' | 'ItemInventory' | 'ItemNonInventory' | 'ItemOtherCharge';
  name: string;
  desc: string;
  price: number;
  cost?: number;
  income: string;
  expense?: string;
  taxable?: boolean;
  qty?: number;
}

const ITEMS: ItemSpec[] = [
  {
    kind: 'ItemService',
    name: 'Diagnostic Call',
    desc: 'Diagnostic service call',
    price: 129,
    income: 'Service Income:Repairs',
  },
  {
    kind: 'ItemService',
    name: 'Labor - Technician',
    desc: 'Technician labor (per hour)',
    price: 115,
    income: 'Service Income:Repairs',
  },
  {
    kind: 'ItemService',
    name: 'Labor - Apprentice',
    desc: 'Apprentice labor (per hour)',
    price: 75,
    income: 'Service Income:Repairs',
  },
  {
    kind: 'ItemService',
    name: 'Installation Labor',
    desc: 'Installation labor (per hour)',
    price: 95,
    income: 'Installation Income',
  },
  {
    kind: 'ItemService',
    name: 'Maintenance Plan - Annual',
    desc: 'Annual maintenance plan: two tune-ups',
    price: 189,
    income: 'Service Income:Maintenance Plans',
  },
  {
    kind: 'ItemService',
    name: 'Tune-Up',
    desc: 'Seasonal furnace or A/C tune-up',
    price: 119,
    income: 'Service Income:Maintenance Plans',
  },
  {
    kind: 'ItemService',
    name: 'Duct Cleaning',
    desc: 'Whole-house duct cleaning',
    price: 450,
    income: 'Service Income:Repairs',
  },
  {
    kind: 'ItemInventory',
    name: 'Air Filter 16x25x1',
    desc: 'Pleated air filter 16x25x1',
    price: 18,
    cost: 6.5,
    income: 'Parts Sales',
    taxable: true,
    qty: 120,
  },
  {
    kind: 'ItemInventory',
    name: 'Air Filter 20x25x4',
    desc: 'Media air filter 20x25x4',
    price: 54,
    cost: 21,
    income: 'Parts Sales',
    taxable: true,
    qty: 60,
  },
  {
    kind: 'ItemInventory',
    name: 'Capacitor 45/5 MFD',
    desc: 'Dual run capacitor 45/5 MFD 440V',
    price: 165,
    cost: 22,
    income: 'Parts Sales',
    taxable: true,
    qty: 40,
  },
  {
    kind: 'ItemInventory',
    name: 'Contactor 30A',
    desc: 'Contactor 2-pole 30A 24V coil',
    price: 145,
    cost: 18.75,
    income: 'Parts Sales',
    taxable: true,
    qty: 30,
  },
  {
    kind: 'ItemInventory',
    name: 'Thermostat - Programmable',
    desc: 'Programmable thermostat, 7-day',
    price: 225,
    cost: 68,
    income: 'Parts Sales',
    taxable: true,
    qty: 25,
  },
  {
    kind: 'ItemInventory',
    name: 'Refrigerant R-410A (lb)',
    desc: 'Refrigerant R-410A, per pound',
    price: 95,
    cost: 14,
    income: 'Parts Sales',
    taxable: true,
    qty: 200,
  },
  {
    kind: 'ItemInventory',
    name: 'Condensate Pump',
    desc: 'Condensate removal pump 115V',
    price: 189,
    cost: 52,
    income: 'Parts Sales',
    taxable: true,
    qty: 15,
  },
  {
    kind: 'ItemInventory',
    name: 'Blower Motor 1/2 HP',
    desc: 'Blower motor 1/2 HP multi-speed',
    price: 489,
    cost: 141,
    income: 'Parts Sales',
    taxable: true,
    qty: 10,
  },
  {
    kind: 'ItemNonInventory',
    name: 'Condenser 3 Ton 16 SEER',
    desc: '3 ton 16 SEER condensing unit',
    price: 4200,
    cost: 2350,
    income: 'Equipment Sales',
    expense: 'Equipment Purchases',
    taxable: true,
  },
  {
    kind: 'ItemNonInventory',
    name: 'Furnace 80k BTU 96%',
    desc: '80,000 BTU 96% AFUE gas furnace',
    price: 3600,
    cost: 1890,
    income: 'Equipment Sales',
    expense: 'Equipment Purchases',
    taxable: true,
  },
  {
    kind: 'ItemNonInventory',
    name: 'Heat Pump 3 Ton',
    desc: '3 ton heat pump system',
    price: 6800,
    cost: 3900,
    income: 'Equipment Sales',
    expense: 'Equipment Purchases',
    taxable: true,
  },
  {
    kind: 'ItemNonInventory',
    name: 'Mini-Split 12k BTU',
    desc: 'Ductless mini-split 12,000 BTU',
    price: 2900,
    cost: 1450,
    income: 'Equipment Sales',
    expense: 'Equipment Purchases',
    taxable: true,
  },
  {
    kind: 'ItemOtherCharge',
    name: 'Trip Charge',
    desc: 'Trip charge',
    price: 49,
    income: 'Service Income:Repairs',
  },
  {
    kind: 'ItemOtherCharge',
    name: 'Disposal Fee',
    desc: 'Old equipment haul-away and disposal',
    price: 125,
    income: 'Installation Income',
  },
  {
    kind: 'ItemOtherCharge',
    name: 'After-Hours Fee',
    desc: 'After-hours / weekend service',
    price: 95,
    income: 'Service Income:Repairs',
  },
];

const VENDORS: [string, string, string, string?][] = [
  // name, type, terms, default expense
  ['Front Range HVAC Supply', 'Supplier', 'Net 30'],
  ['Peak Refrigeration Parts', 'Supplier', 'Net 30'],
  ['Metro Sheet Metal Works', 'Subcontractor', 'Net 15'],
  ['Clearwater Electrical Contractors', 'Subcontractor', 'Net 15'],
  ['City Power and Light', 'Utilities', 'Due on receipt'],
  ['Mountain Telecom', 'Utilities', 'Due on receipt'],
  ['Riverside Properties LLC', 'Landlord', 'Due on receipt'],
  ['Northstar Insurance Agency', 'Insurance', 'Due on receipt'],
  ['Fleetline Fuel Cards', 'Supplier', 'Net 15'],
  ['Brightside Marketing', 'Services', 'Net 30'],
  ['Hughes & Ortiz CPAs', 'Services', 'Net 30'],
  ['State Department of Revenue', 'Tax Agency', 'Due on receipt'],
];

export function seedSampleCompany(engine: Engine, opts: SeedOptions = {}): SeedSummary {
  const saved = engine.clock;
  const realToday = localYmd(saved.now());
  const anchor = opts.anchor === 'today' ? realToday : (opts.anchor ?? '2026-10-31');
  const rng = new Rng(opts.seed ?? 20_261_031);
  const s = new Seeder(engine);
  const start = addDays(anchor, -364);
  const setup = addDays(start, -30);
  try {
    s.at(setup);
    // Chart of accounts.
    for (const [num, name, type, parent, ob] of ACCOUNTS) {
      const body: Json = { Name: name, AccountType: type, AccountNumber: String(num) };
      if (parent) body.ParentRef = ref(parent);
      if (ob) {
        body.OpenBalance = ob;
        body.OpenBalanceDate = setup;
      }
      s.run('AccountAddRq', body);
    }
    for (const n of ['Residential', 'Commercial']) s.run('ClassAddRq', { Name: n });
    for (const n of ['Residential', 'Commercial', 'Property Manager'])
      s.run('CustomerTypeAddRq', { Name: n });
    for (const n of [
      'Supplier',
      'Subcontractor',
      'Utilities',
      'Landlord',
      'Insurance',
      'Services',
      'Tax Agency',
    ])
      s.run('VendorTypeAddRq', { Name: n });
    for (const n of ['Repair', 'Maintenance', 'Installation']) s.run('JobTypeAddRq', { Name: n });
    for (const [n, t] of [
      ['Cash', 'Cash'],
      ['Check', 'Check'],
      ['Visa', 'Visa'],
      ['MasterCard', 'MasterCard'],
      ['American Express', 'AmericanExpress'],
      ['ACH', 'ECheck'],
    ] as const)
      s.run('PaymentMethodAddRq', { Name: n, PaymentMethodType: t });
    for (const n of ['Will Call', 'Delivery']) s.run('ShipMethodAddRq', { Name: n });
    for (const n of [
      'Thank you for your business!',
      'Please remit within terms. Thank you!',
      'We appreciate your prompt payment.',
    ])
      s.run('CustomerMsgAddRq', { Name: n });
    s.run('StandardTermsAddRq', { Name: 'Due on receipt', StdDueDays: 0 });
    s.run('StandardTermsAddRq', { Name: 'Net 15', StdDueDays: 15 });
    s.run('StandardTermsAddRq', { Name: 'Net 30', StdDueDays: 30 });
    s.run('StandardTermsAddRq', {
      Name: '1% 10 Net 30',
      StdDueDays: 30,
      StdDiscountDays: 10,
      DiscountPct: 1,
    });
    s.run('SalesTaxCodeAddRq', { Name: 'Tax', IsTaxable: true, Desc: 'Taxable sales' });
    s.run('SalesTaxCodeAddRq', { Name: 'Non', IsTaxable: false, Desc: 'Non-taxable sales' });

    for (const [name, type, terms] of VENDORS) {
      s.run('VendorAddRq', {
        Name: name,
        CompanyName: name.slice(0, 41),
        VendorAddress: {
          Addr1: name.slice(0, 41),
          Addr2: `${rng.int(100, 9900)} Commerce Blvd`,
          City: 'Springfield',
          State: 'CO',
          PostalCode: '80010',
        },
        Phone: `555-01${String(rng.int(10, 99))}`,
        VendorTypeRef: ref(type),
        TermsRef: ref(terms),
        IsVendorEligibleFor1099: type === 'Subcontractor',
        ...(type === 'Tax Agency' ? { IsSalesTaxAgency: true } : {}),
      });
    }
    s.run('ItemSalesTaxAddRq', {
      Name: 'County Sales Tax',
      ItemDesc: 'Springfield County sales tax',
      TaxRate: 7.25,
      TaxVendorRef: ref('State Department of Revenue'),
    });

    const techs = [
      ['Marcus', 'Webb', 'Lead Technician'],
      ['Elena', 'Ruiz', 'Service Technician'],
      ['Tyler', 'Brooks', 'Service Technician'],
      ['Hannah', 'Price', 'Installer'],
      ['Omar', 'Haddad', 'Apprentice'],
      ['Grace', 'Liu', 'Office Manager'],
    ];
    for (const [first, last, title] of techs) {
      s.run('EmployeeAddRq', {
        FirstName: first,
        LastName: last,
        JobTitle: title,
        Phone: `555-01${String(rng.int(10, 99))}`,
        Email: `${first!.toLowerCase()}.${last!.toLowerCase()}@example.com`,
        EmployeeType: 'Regular',
        HiredDate: addDays(setup, -rng.int(200, 2500)),
      });
    }
    s.run('SalesRepAddRq', { Initial: 'MW', SalesRepEntityRef: ref('Marcus Webb') });
    s.run('SalesRepAddRq', { Initial: 'GL', SalesRepEntityRef: ref('Grace Liu') });

    for (const it of ITEMS) {
      const tax = ref(it.taxable ? 'Tax' : 'Non');
      if (it.kind === 'ItemInventory') {
        s.run('ItemInventoryAddRq', {
          Name: it.name,
          SalesTaxCodeRef: tax,
          SalesDesc: it.desc,
          SalesPrice: it.price,
          IncomeAccountRef: ref(it.income),
          PurchaseDesc: it.desc,
          PurchaseCost: it.cost,
          COGSAccountRef: ref('Cost of Goods Sold'),
          PrefVendorRef: ref('Front Range HVAC Supply'),
          AssetAccountRef: ref('Inventory Asset'),
          ReorderPoint: Math.max(2, Math.round((it.qty ?? 10) / 5)),
          QuantityOnHand: it.qty,
          InventoryDate: setup,
        });
      } else if (it.kind === 'ItemNonInventory') {
        s.run('ItemNonInventoryAddRq', {
          Name: it.name,
          SalesTaxCodeRef: tax,
          SalesAndPurchase: {
            SalesDesc: it.desc,
            SalesPrice: it.price,
            IncomeAccountRef: ref(it.income),
            PurchaseDesc: it.desc,
            PurchaseCost: it.cost,
            ExpenseAccountRef: ref(it.expense ?? 'Equipment Purchases'),
            PrefVendorRef: ref('Front Range HVAC Supply'),
          },
        });
      } else {
        s.run(`${it.kind}AddRq`, {
          Name: it.name,
          SalesTaxCodeRef: tax,
          SalesOrPurchase: { Desc: it.desc, Price: it.price, AccountRef: ref(it.income) },
        });
      }
    }
    s.run('ItemDiscountAddRq', {
      Name: 'Senior Discount',
      ItemDesc: 'Senior discount 10%',
      SalesTaxCodeRef: ref('Non'),
      DiscountRatePercent: 10,
      AccountRef: ref('Discounts Given'),
    });
    s.run('ItemSubtotalAddRq', { Name: 'Subtotal', ItemDesc: 'Subtotal' });
    s.run('ItemGroupAddRq', {
      Name: 'Tune-Up Package',
      ItemDesc: 'Tune-up with standard filter',
      IsPrintItemsInGroup: true,
      ItemGroupLine: [
        { ItemRef: ref('Tune-Up'), Quantity: 1 },
        { ItemRef: ref('Air Filter 16x25x1'), Quantity: 1 },
      ],
    });

    // Customers: residential homeowners and commercial accounts with jobs.
    const customers: { name: string; commercial: boolean; senior: boolean }[] = [];
    const used = new Set<string>();
    for (let i = 0; i < 26; i++) {
      let first = '';
      let last = '';
      do {
        first = rng.pick(FIRST);
        last = rng.pick(LAST);
      } while (used.has(`${last}, ${first}`));
      used.add(`${last}, ${first}`);
      const name = `${last}, ${first}`;
      const senior = rng.chance(0.15);
      s.run('CustomerAddRq', {
        Name: name,
        FirstName: first,
        LastName: last,
        BillAddress: {
          Addr1: `${first} ${last}`,
          Addr2: `${rng.int(100, 9999)} ${rng.pick(STREETS)}`,
          City: 'Springfield',
          State: 'CO',
          PostalCode: `800${rng.int(10, 99)}`,
        },
        Phone: `555-01${String(rng.int(10, 99))}`,
        Email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
        CustomerTypeRef: ref('Residential'),
        TermsRef: ref('Due on receipt'),
        SalesTaxCodeRef: ref('Tax'),
        ItemSalesTaxRef: ref('County Sales Tax'),
        PreferredDeliveryMethod: 'Email',
      });
      customers.push({ name, commercial: false, senior });
    }
    for (const [name, type, jobs] of COMMERCIAL) {
      s.run('CustomerAddRq', {
        Name: name,
        CompanyName: name,
        BillAddress: {
          Addr1: name,
          Addr2: `${rng.int(100, 9999)} ${rng.pick(['Main St', 'Commerce Dr', 'Market St', 'Industrial Pkwy'])}`,
          City: 'Springfield',
          State: 'CO',
          PostalCode: `800${rng.int(10, 99)}`,
        },
        Phone: `555-01${String(rng.int(10, 99))}`,
        Email: `ap@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`.slice(0, 1023),
        CustomerTypeRef: ref(type),
        TermsRef: ref(rng.chance(0.5) ? 'Net 30' : 'Net 15'),
        SalesRepRef: ref('MW'),
        SalesTaxCodeRef: ref('Tax'),
        ItemSalesTaxRef: ref('County Sales Tax'),
        CreditLimit: 25000,
      });
      if (jobs?.length) {
        for (const j of jobs) {
          s.run('CustomerAddRq', {
            Name: j,
            ParentRef: ref(name),
            JobStatus: 'InProgress',
            JobTypeRef: ref('Maintenance'),
          });
          customers.push({ name: `${name}:${j}`, commercial: true, senior: false });
        }
      } else customers.push({ name, commercial: true, senior: false });
    }
    s.run('OtherNameAddRq', { Name: 'Owner Draw' });

    // -----------------------------------------------------------------------
    // About a year of activity.
    const invoices: { id: string; date: string; total: number; customer: string }[] = [];
    const bills: { id: string; date: string; total: number; vendor: string }[] = [];
    const ufPayments: { id: string; date: string }[] = [];
    const svc = ITEMS.filter((i) => i.kind === 'ItemInventory');
    const equipment = ITEMS.filter((i) => i.kind === 'ItemNonInventory');
    let checkNo = 4100;

    const salesLines = (kind: number): Json[] => {
      const lines: Json[] = [];
      if (kind === 0) {
        lines.push({ ItemRef: ref('Diagnostic Call'), Quantity: 1 });
        lines.push({ ItemRef: ref('Labor - Technician'), Quantity: rng.int(1, 4) });
        for (let k = rng.int(1, 2); k > 0; k--)
          lines.push({ ItemRef: ref(rng.pick(svc).name), Quantity: rng.int(1, 2) });
        if (rng.chance(0.15)) lines.push({ ItemRef: ref('After-Hours Fee'), Quantity: 1 });
      } else if (kind === 1) {
        lines.push({
          ItemRef: ref(rng.chance(0.5) ? 'Maintenance Plan - Annual' : 'Tune-Up'),
          Quantity: 1,
        });
        lines.push({
          ItemRef: ref(rng.pick(['Air Filter 16x25x1', 'Air Filter 20x25x4'])),
          Quantity: rng.int(1, 3),
        });
      } else {
        const eq = rng.pick(equipment);
        lines.push({ ItemRef: ref(eq.name), Quantity: 1 });
        lines.push({ ItemRef: ref('Installation Labor'), Quantity: rng.int(8, 16) });
        lines.push({ ItemRef: ref('Thermostat - Programmable'), Quantity: 1 });
        lines.push({ ItemRef: ref('Disposal Fee'), Quantity: 1 });
      }
      return lines;
    };

    for (let day = 0; day < 365; day += 1) {
      const date = addDays(start, day);
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const dom = Number(date.slice(8));

      // Invoices: about one a week.
      if (rng.chance(0.2)) {
        s.at(date);
        const c = rng.pick(customers);
        const kind = rng.chance(0.15) ? 2 : rng.chance(0.4) ? 1 : 0;
        const lines = salesLines(kind);
        if (c.senior && kind !== 2) lines.push({ ItemRef: ref('Senior Discount') });
        const body: Json = {
          CustomerRef: ref(c.name),
          ClassRef: ref(c.commercial ? 'Commercial' : 'Residential'),
          TxnDate: date,
          CustomerMsgRef: ref('Thank you for your business!'),
          Memo:
            kind === 2
              ? 'Equipment replacement'
              : kind === 1
                ? 'Seasonal maintenance'
                : 'Service call',
          InvoiceLineAdd: lines,
        };
        if (kind === 1 && rng.chance(0.3)) {
          delete body.InvoiceLineAdd;
          body.InvoiceLineGroupAdd = [{ ItemGroupRef: ref('Tune-Up Package'), Quantity: 1 }];
        }
        const inv = s.run('InvoiceAddRq', body);
        invoices.push({
          id: String(inv.TxnID),
          date,
          total: Number(inv.BalanceRemaining),
          customer: c.name,
        });
      }
      // Cash sales on site.
      if (rng.chance(0.06)) {
        s.at(date);
        const c = rng.pick(customers.filter((x) => !x.commercial));
        s.run('SalesReceiptAddRq', {
          CustomerRef: ref(c.name),
          TxnDate: date,
          PaymentMethodRef: ref(rng.pick(['Cash', 'Check', 'Visa', 'MasterCard'])),
          DepositToAccountRef: ref('Checking'),
          SalesReceiptLineAdd: salesLines(rng.chance(0.5) ? 0 : 1),
        });
      }
      // Customer payments for invoices 5-40 days old.
      for (const inv of invoices.filter((x) => x.total > 0 && x.date < addDays(date, -5))) {
        const age = Math.round((Date.parse(date) - Date.parse(inv.date)) / 86_400_000);
        if (!rng.chance(age > 40 ? 0.05 : 0.09)) continue;
        s.at(date);
        const partial = rng.chance(0.1) && inv.total > 300;
        const amount = partial ? Math.round(inv.total * 50) / 100 : inv.total;
        const pay = s.run('ReceivePaymentAddRq', {
          CustomerRef: ref(inv.customer),
          TxnDate: date,
          RefNumber: String(rng.int(1000, 9999)),
          TotalAmount: amount,
          PaymentMethodRef: ref(rng.pick(['Check', 'Visa', 'MasterCard', 'ACH'])),
          AppliedToTxnAdd: [{ TxnID: inv.id, PaymentAmount: amount }],
        });
        inv.total = Math.round((inv.total - amount) * 100) / 100;
        ufPayments.push({ id: String(pay.TxnID), date });
      }
      // Deposit undeposited payments on the last Friday of the month.
      if (dow === 5 && dom >= 23 && ufPayments.length) {
        s.at(date);
        s.run('DepositAddRq', {
          TxnDate: date,
          DepositToAccountRef: ref('Checking'),
          Memo: 'Weekly deposit',
          DepositLineAdd: ufPayments.map((p) => ({ PaymentTxnID: p.id })),
        });
        ufPayments.length = 0;
      }
      // Monthly bills.
      if (dom === 1) {
        s.at(date);
        bills.push(
          bill(s, date, 'Riverside Properties LLC', [
            { AccountRef: ref('Rent Expense'), Amount: 2850, Memo: 'Shop rent' },
          ]),
        );
        if (Number(date.slice(5, 7)) % 3 === 1)
          bills.push(
            bill(s, date, 'Northstar Insurance Agency', [
              {
                AccountRef: ref('Insurance Expense'),
                Amount: 1845,
                Memo: 'Quarterly liability and fleet insurance',
              },
            ]),
          );
      }
      if (dom === 12) {
        s.at(date);
        bills.push(
          bill(s, date, 'City Power and Light', [
            { AccountRef: ref('Utilities'), Amount: rng.int(260, 540) + rng.int(0, 99) / 100 },
          ]),
        );
      }
      // Parts restock and equipment for installs.
      if (rng.chance(0.05)) {
        s.at(date);
        const vendor = rng.chance(0.6) ? 'Front Range HVAC Supply' : 'Peak Refrigeration Parts';
        const lines = Array.from({ length: rng.int(2, 4) }, () => {
          const it = rng.pick(svc);
          return { ItemRef: ref(it.name), Quantity: rng.int(2, 12), Cost: it.cost };
        });
        if (rng.chance(0.3)) {
          const eq = rng.pick(equipment);
          lines.push({ ItemRef: ref(eq.name), Quantity: 1, Cost: eq.cost });
        }
        const b = s.run('BillAddRq', {
          VendorRef: ref(vendor),
          TxnDate: date,
          RefNumber: `INV-${rng.int(10000, 99999)}`,
          ItemLineAdd: lines,
        });
        bills.push({ id: String(b.TxnID), date, total: Number(b.AmountDue), vendor });
      }
      if (rng.chance(0.02)) {
        s.at(date);
        const vendor = rng.pick(['Metro Sheet Metal Works', 'Clearwater Electrical Contractors']);
        bills.push(
          bill(s, date, vendor, [
            {
              AccountRef: ref('Subcontractors'),
              Amount: rng.int(450, 2400),
              Memo: 'Subcontracted install work',
            },
          ]),
        );
      }
      // Pay bills twice a month.
      if (dom === 10 || dom === 25) {
        const due = bills.filter((x) => x.total > 0 && x.date < addDays(date, -3));
        for (const vendor of [...new Set(due.map((x) => x.vendor))]) {
          const mine = due.filter((x) => x.vendor === vendor);
          s.at(date);
          s.run('BillPaymentCheckAddRq', {
            PayeeEntityRef: ref(vendor),
            TxnDate: date,
            BankAccountRef: ref('Checking'),
            RefNumber: String(checkNo++),
            Memo: 'Bill payment',
            AppliedToTxnAdd: mine.map((x) => ({ TxnID: x.id, PaymentAmount: x.total })),
          });
          for (const x of mine) x.total = 0;
        }
      }
      // Fuel and supplies on the card, misc checks.
      if (rng.chance(0.04)) {
        s.at(date);
        s.run('CreditCardChargeAddRq', {
          AccountRef: ref('Business Credit Card'),
          PayeeEntityRef: ref(rng.chance(0.6) ? 'Fleetline Fuel Cards' : 'Front Range HVAC Supply'),
          TxnDate: date,
          ExpenseLineAdd: [
            rng.chance(0.6)
              ? {
                  AccountRef: ref('Automobile Expense:Fuel'),
                  Amount: rng.int(180, 620) + rng.int(0, 99) / 100,
                  Memo: 'Fleet fuel',
                }
              : {
                  AccountRef: ref('Small Tools and Supplies'),
                  Amount: rng.int(40, 380) + rng.int(0, 99) / 100,
                  Memo: 'Shop supplies',
                },
          ],
        });
      }
      if (dom === 20) {
        s.at(date);
        if (Number(date.slice(5, 7)) % 2 === 0)
          s.run('CheckAddRq', {
            AccountRef: ref('Checking'),
            PayeeEntityRef: ref('Brightside Marketing'),
            RefNumber: String(checkNo++),
            TxnDate: date,
            ExpenseLineAdd: [
              {
                AccountRef: ref('Advertising and Marketing'),
                Amount: rng.int(350, 900),
                Memo: 'Local ads',
              },
            ],
          });
        else
          s.run('CheckAddRq', {
            AccountRef: ref('Checking'),
            PayeeEntityRef: ref('Fleetline Fuel Cards'),
            RefNumber: String(checkNo++),
            TxnDate: date,
            Memo: 'Card payment',
            ExpenseLineAdd: [
              { AccountRef: ref('Business Credit Card'), Amount: rng.int(600, 1400) },
            ],
          });
      }
      // Quarter-end depreciation and loan interest.
      if (dow === 5 && dom >= 23 && Number(date.slice(5, 7)) % 3 === 0) {
        s.at(date);
        const dep = rng.int(2400, 3100);
        s.run('JournalEntryAddRq', {
          TxnDate: date,
          RefNumber: `DEP-${date.slice(0, 7)}`.slice(0, 11),
          Memo: 'Quarterly depreciation',
          JournalDebitLine: [{ AccountRef: ref('Depreciation Expense'), Amount: dep }],
          JournalCreditLine: [{ AccountRef: ref('Accumulated Depreciation'), Amount: dep }],
        });
        const interest = rng.int(520, 610);
        s.run('JournalEntryAddRq', {
          TxnDate: date,
          Memo: 'Vehicle loan payment',
          JournalDebitLine: [
            { AccountRef: ref('Vehicle Loan'), Amount: 1450 },
            { AccountRef: ref('Interest Expense'), Amount: interest },
          ],
          JournalCreditLine: [{ AccountRef: ref('Checking'), Amount: 1450 + interest }],
        });
      }
      // Estimates, sales orders, purchase orders.
      if (rng.chance(0.03)) {
        s.at(date);
        const c = rng.pick(customers);
        s.run('EstimateAddRq', {
          CustomerRef: ref(c.name),
          TxnDate: date,
          Memo: 'Replacement proposal',
          EstimateLineAdd: salesLines(2),
        });
      }
      if (rng.chance(0.012)) {
        s.at(date);
        s.run('SalesOrderAddRq', {
          CustomerRef: ref(rng.pick(customers.filter((x) => x.commercial)).name),
          TxnDate: date,
          SalesOrderLineAdd: salesLines(2),
        });
      }
      if (rng.chance(0.012)) {
        s.at(date);
        const eq = rng.pick(equipment);
        s.run('PurchaseOrderAddRq', {
          VendorRef: ref('Front Range HVAC Supply'),
          TxnDate: date,
          PurchaseOrderLineAdd: [{ ItemRef: ref(eq.name), Quantity: rng.int(1, 3), Rate: eq.cost }],
        });
      }
      if (dom === 15 && Number(date.slice(5, 7)) % 6 === 0) {
        s.at(date);
        s.run('TransferAddRq', {
          TxnDate: date,
          TransferFromAccountRef: ref('Checking'),
          TransferToAccountRef: ref('Savings'),
          Amount: 5000,
          Memo: 'Reserve transfer',
        });
      }
    }
    // A couple of credits and a vendor credit.
    s.at(addDays(anchor, -40));
    for (let i = 0; i < 3; i++) {
      const c = rng.pick(customers);
      s.run('CreditMemoAddRq', {
        CustomerRef: ref(c.name),
        TxnDate: addDays(anchor, -40 + i * 9),
        Memo: 'Goodwill credit',
        CreditMemoLineAdd: [{ ItemRef: ref('Trip Charge'), Quantity: 1 }],
      });
    }
    s.run('VendorCreditAddRq', {
      VendorRef: ref('Front Range HVAC Supply'),
      TxnDate: addDays(anchor, -20),
      RefNumber: `CR-${rng.int(1000, 9999)}`,
      ItemLineAdd: [{ ItemRef: ref('Capacitor 45/5 MFD'), Quantity: 2, Cost: 22 }],
    });
    // Remaining undeposited payments.
    if (ufPayments.length) {
      s.at(anchor);
      s.run('DepositAddRq', {
        TxnDate: anchor,
        DepositToAccountRef: ref('Checking'),
        DepositLineAdd: ufPayments.map((p) => ({ PaymentTxnID: p.id })),
      });
    }
  } finally {
    engine.clock = saved;
  }
  return { lists: s.lists, transactions: s.txns, anchor };
}

function bill(
  s: Seeder,
  date: string,
  vendor: string,
  lines: Json[],
): { id: string; date: string; total: number; vendor: string } {
  const b = s.run('BillAddRq', { VendorRef: ref(vendor), TxnDate: date, ExpenseLineAdd: lines });
  return { id: String(b.TxnID), date, total: Number(b.AmountDue), vendor };
}
