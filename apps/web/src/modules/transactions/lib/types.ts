/** Shared types for the purpose-built transaction forms. */

/** A list reference as qbXML carries it: `{ ListID, FullName }`. */
export interface RefValue {
  ListID?: string;
  FullName?: string;
  /** Catalog entity the option came from (e.g. `ItemService`). */
  type?: string;
  /** Full Ret from the read model, when picked from a list. */
  data?: Record<string, unknown>;
}

/** Named sources of reference options; see lib/refs.ts. */
export type RefSourceName =
  | 'Customer'
  | 'Vendor'
  | 'Employee'
  | 'Payee'
  | 'Entity'
  | 'SalesItem'
  | 'PurchaseItem'
  | 'Item'
  | 'Account'
  | 'BankAccount'
  | 'CreditCardAccount'
  | 'ARAccount'
  | 'APAccount'
  | 'DepositAccount'
  | 'Terms'
  | 'Class'
  | 'SalesTax'
  | 'SalesTaxCode'
  | 'PaymentMethod'
  | 'SalesRep'
  | 'ShipMethod'
  | 'CustomerMsg'
  | 'Template';

export interface Address {
  Addr1?: string;
  Addr2?: string;
  Addr3?: string;
  Addr4?: string;
  Addr5?: string;
  City?: string;
  State?: string;
  PostalCode?: string;
  Country?: string;
  Note?: string;
}

export type HeaderKind =
  'ref' | 'date' | 'text' | 'textarea' | 'bool' | 'amount' | 'price' | 'qty' | 'enum' | 'address';

export interface HeaderField {
  /** qbXML element name in the Add/Mod object. */
  name: string;
  label: string;
  kind: HeaderKind;
  ref?: RefSourceName;
  /** Required by the form (QuickBooks may require more). */
  required?: boolean;
  /** Only sent on Add (not part of the Mod object). */
  addOnly?: boolean;
  /** Only sent on Mod. */
  modOnly?: boolean;
  /** Fallback when /api/meta is unavailable. */
  maxLength?: number;
  options?: string[];
  /**
   * Where the field is laid out: the top block (default), the address row,
   * the detail row under it, or the footer next to the totals. Fields are
   * always listed in schema order; placement is visual only.
   */
  slot?: 'main' | 'address' | 'detail' | 'footer';
}

export type LineKind = 'ref' | 'text' | 'qty' | 'price' | 'amount' | 'enum' | 'bool' | 'date';

export interface LineColumn {
  name: string;
  label: string;
  kind: LineKind;
  ref?: RefSourceName;
  maxLength?: number;
  options?: string[];
  /** CSS width hint. */
  width?: string;
  /** Not part of the Mod line object. */
  addOnly?: boolean;
}

export interface LineSection {
  /** State key, e.g. 'lines', 'expenses', 'items'. */
  key: string;
  label: string;
  /** Element names in the Add object, Mod object and Ret. */
  add: string;
  mod: string;
  ret: string;
  columns: LineColumn[];
  /** Quantity x rate pricing (rate field is `Rate` or `Cost`). */
  pricing?: { qty: string; rate: string; amount: string };
  /** Where an item's defaults come from when picked. */
  itemDefaults?: 'sales' | 'purchase';
  /** Column that marks a line as used (the line is skipped when it and the amount are empty). */
  keyColumn: string;
  /** Mod flag that clears every line of this kind (ClearExpenseLines / ClearItemLines). */
  clearFlag?: string;
}

export type TotalsKind = 'sales' | 'purchase' | 'header-amount' | 'none';

export interface TxnSpec {
  /** URL slug: /transactions/<slug>/new. */
  slug: string;
  /** Catalog entity, also the /api/objects/<type> path segment. */
  type: string;
  label: string;
  /** Element names of the Add and Mod objects. */
  addObject: string;
  modObject: string | null;
  /** Ret element. */
  retObject: string;
  header: HeaderField[];
  lines: LineSection[];
  totals: TotalsKind;
  /** The header ref that names the counterparty (prefilled from ?entity=). */
  entityField?: string;
  entityKind?: 'customer' | 'vendor' | 'payee';
  /** At least one line is required. */
  requireLine: boolean;
  /** Header pricing (Statement Charge): Quantity x Rate = Amount. */
  headerPricing?: { qty: string; rate: string; amount: string };
  /** Field that receives the computed due date when terms change. */
  dueDateField?: string;
  /** Label of the total in the footer. */
  totalLabel: string;
  /** Sidebar placement. */
  area: 'Customers' | 'Vendors' | 'Banking' | 'Company';
  icon: string;
  order: number;
}

/** One editable line. `values` holds raw form input keyed by element name. */
export interface TxnLine {
  key: string;
  TxnLineID?: string;
  values: Record<string, unknown>;
  /** Which pricing input the user changed last ('rate' or 'amount'). */
  lastEdited?: 'rate' | 'amount';
}

export interface TxnFormState {
  TxnID?: string;
  EditSequence?: string;
  header: Record<string, unknown>;
  lines: Record<string, TxnLine[]>;
  /** Section keys that had lines when loaded (for Clear*Lines on Mod). */
  loadedSections?: string[];
}

/** A row from GET /api/objects/:type, normalised. */
export interface ObjectRow {
  type: string;
  id: string;
  name?: string;
  refNumber?: string;
  txnDate?: string;
  amount?: string;
  editSequence?: string;
  timeModified?: string;
  data: Record<string, unknown>;
}

export interface ObjectList {
  items: ObjectRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** One row of a totals footer. */
export interface TotalRow {
  label: string;
  value: string;
  strong?: boolean;
  hint?: string;
}
