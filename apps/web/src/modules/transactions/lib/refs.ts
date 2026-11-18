/**
 * Reference sources for pickers: which read-model types to search, with
 * optional filters (e.g. only Bank accounts), and how to turn a row into a
 * qbXML ref.
 */
import type { ObjectRow, RefSourceName, RefValue } from './types';

export interface RefSource {
  label: string;
  /** Catalog entity types searched in parallel. */
  types: string[];
  /** filter[...] params applied to every type. */
  filter?: Record<string, string>;
}

export const SALES_ITEM_TYPES = [
  'ItemService',
  'ItemNonInventory',
  'ItemInventory',
  'ItemInventoryAssembly',
  'ItemOtherCharge',
  'ItemDiscount',
  'ItemSubtotal',
  'ItemPayment',
  'ItemGroup',
  'ItemSalesTax',
  'ItemSalesTaxGroup',
];

export const PURCHASE_ITEM_TYPES = [
  'ItemService',
  'ItemNonInventory',
  'ItemInventory',
  'ItemInventoryAssembly',
  'ItemOtherCharge',
  'ItemGroup',
];

export const REF_SOURCES: Record<RefSourceName, RefSource> = {
  Customer: { label: 'customer', types: ['Customer'] },
  Vendor: { label: 'vendor', types: ['Vendor'] },
  Employee: { label: 'employee', types: ['Employee'] },
  Payee: { label: 'payee', types: ['Vendor', 'Customer', 'Employee', 'OtherName'] },
  Entity: { label: 'name', types: ['Customer', 'Vendor', 'Employee', 'OtherName'] },
  SalesItem: { label: 'item', types: SALES_ITEM_TYPES },
  PurchaseItem: { label: 'item', types: PURCHASE_ITEM_TYPES },
  Item: { label: 'item', types: SALES_ITEM_TYPES },
  Account: { label: 'account', types: ['Account'] },
  BankAccount: { label: 'bank account', types: ['Account'], filter: { AccountType: 'Bank' } },
  CreditCardAccount: {
    label: 'credit card account',
    types: ['Account'],
    filter: { AccountType: 'CreditCard' },
  },
  ARAccount: {
    label: 'A/R account',
    types: ['Account'],
    filter: { AccountType: 'AccountsReceivable' },
  },
  APAccount: {
    label: 'A/P account',
    types: ['Account'],
    filter: { AccountType: 'AccountsPayable' },
  },
  DepositAccount: {
    label: 'account',
    types: ['Account'],
    filter: { AccountType: 'in:Bank,OtherCurrentAsset' },
  },
  Terms: { label: 'terms', types: ['StandardTerms', 'DateDrivenTerms'] },
  Class: { label: 'class', types: ['Class'] },
  SalesTax: { label: 'sales tax item', types: ['ItemSalesTax', 'ItemSalesTaxGroup'] },
  SalesTaxCode: { label: 'tax code', types: ['SalesTaxCode'] },
  PaymentMethod: { label: 'payment method', types: ['PaymentMethod'] },
  SalesRep: { label: 'rep', types: ['SalesRep'] },
  ShipMethod: { label: 'shipping method', types: ['ShipMethod'] },
  CustomerMsg: { label: 'message', types: ['CustomerMsg'] },
  Template: { label: 'template', types: ['Template'] },
};

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

/** Display name for a list row: FullName, then Name, then the read-model name. */
export function displayName(row: ObjectRow): string {
  const d = row.data;
  return str(d.FullName) ?? str(d.Name) ?? row.name ?? row.id;
}

export function rowToRef(row: ObjectRow): RefValue {
  return {
    ListID: str(row.data.ListID) ?? row.id,
    FullName: displayName(row),
    type: row.type,
    data: row.data,
  };
}

/** The qbXML form of a ref: ListID when known, otherwise FullName. Null when empty. */
export function refOut(v: unknown): { ListID: string } | { FullName: string } | null {
  if (!v || typeof v !== 'object') {
    if (typeof v === 'string' && v.trim()) return { FullName: v.trim() };
    return null;
  }
  const r = v as RefValue;
  if (r.ListID) return { ListID: r.ListID };
  if (r.FullName && r.FullName.trim()) return { FullName: r.FullName.trim() };
  return null;
}

/** Normalise a Ret's ref (`{ListID, FullName}`) into a RefValue, or null. */
export function refIn(v: unknown): RefValue | null {
  const x = Array.isArray(v) ? v[0] : v;
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  const ListID = str(r.ListID);
  const FullName = str(r.FullName);
  if (!ListID && !FullName) return null;
  return { ...(ListID ? { ListID } : {}), ...(FullName ? { FullName } : {}) };
}

export function refLabel(v: unknown): string {
  if (!v || typeof v !== 'object') return typeof v === 'string' ? v : '';
  const r = v as RefValue;
  return r.FullName ?? r.ListID ?? '';
}

export function sameRef(a: unknown, b: unknown): boolean {
  const x = refIn(a);
  const y = refIn(b);
  if (!x || !y) return !x && !y;
  if (x.ListID && y.ListID) return x.ListID === y.ListID;
  return (x.FullName ?? '').toLowerCase() === (y.FullName ?? '').toLowerCase();
}
