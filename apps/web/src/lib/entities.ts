/**
 * Entity helpers: which area of the app an entity belongs to, and which
 * entity types a `...Ref` field points at.
 */
import type { NavArea } from '@/modules/types';

const AREA_OF: Record<string, NavArea> = {};
const assign = (area: NavArea, names: string[]) => names.forEach((n) => (AREA_OF[n] = area));

assign('Customers', [
  'Customer',
  'Invoice',
  'Estimate',
  'SalesOrder',
  'SalesReceipt',
  'CreditMemo',
  'ReceivePayment',
  'ARRefundCreditCard',
  'Charge',
  'Lead',
  'CustomerType',
  'CustomerMsg',
  'JobType',
  'StatementCharge',
]);
assign('Vendors', [
  'Vendor',
  'Bill',
  'BillPaymentCheck',
  'BillPaymentCreditCard',
  'BillToPay',
  'PurchaseOrder',
  'ItemReceipt',
  'VendorCredit',
  'VendorType',
  'SalesTaxPaymentCheck',
  'SalesTaxPayable',
]);
assign('Employees', [
  'Employee',
  'TimeTracking',
  'Paycheck',
  'PayrollLiabilityCheck',
  'PayrollLiabilityAdjustment',
  'PayrollPriorPayment',
  'PayrollYearToDateAdjustment',
  'PayrollLastPeriod',
  'EmployeeDefault',
  'WorkersCompCode',
  'VehicleMileage',
  'Vehicle',
  'BillingRate',
]);
assign('Banking', [
  'Check',
  'Deposit',
  'Transfer',
  'CreditCardCharge',
  'CreditCardCredit',
  'JournalEntry',
  'ReceivePaymentToDeposit',
]);
assign('Company', [
  'Company',
  'CompanyActivity',
  'Preferences',
  'Host',
  'Currency',
  'Template',
  'DataExtDef',
  'DataEventSubscription',
  'UIEventSubscription',
  'UIExtensionSubscription',
  'DataEventRecoveryInfo',
  'ToDo',
  'Alert',
]);

/** Sidebar area of an entity; payroll items and everything else default to Lists. */
export function areaOf(entity: string): NavArea {
  return AREA_OF[entity] ?? 'Lists';
}

/** List types ListMergeRq can merge (its ListMergeType values). */
export const MERGEABLE_ENTITIES = [
  'Account',
  'Class',
  'Customer',
  'ItemDiscount',
  'ItemGroup',
  'ItemInventory',
  'ItemNonInventory',
  'ItemOtherCharge',
  'ItemPayment',
  'ItemSalesTax',
  'ItemSalesTaxGroup',
  'ItemService',
  'ItemSubtotal',
  'Vendor',
];

/** Entities a list ref of a party (EntityRef, PayeeEntityRef, ...) can point at. */
export const PARTY_ENTITIES = ['Customer', 'Vendor', 'Employee', 'OtherName'];
export const TERMS_ENTITIES = ['StandardTerms', 'DateDrivenTerms'];
const NOT_ITEMS = new Set(['ItemSites', 'ItemAssembliesCanBuild']);

export function itemEntities(all: readonly string[]): string[] {
  return all.filter((n) => n.startsWith('Item') && !NOT_ITEMS.has(n));
}

/**
 * Entity types a `...Ref` field can reference.
 *  - `CustomerRef` -> Customer (exact match)
 *  - `ARAccountRef`, `DepositToAccountRef` -> Account (longest entity-name suffix)
 *  - `ItemRef` -> every Item* type; `TermsRef` -> both terms lists
 *  - `EntityRef`, `PayeeEntityRef`, `ReceiveFromRef`... -> customer/vendor/employee/other name
 *  - `ParentRef` -> the owning entity (or its item family)
 */
export function refTargets(fieldName: string, all: readonly string[], owner?: string): string[] {
  const base = fieldName.replace(/Ref$/, '');
  const has = new Set(all);
  if (base === 'Parent' && owner) {
    return owner.startsWith('Item') ? itemEntities(all) : [owner];
  }
  if (base === 'Item' || /Item$/.test(base) || base === 'ItemGroup') {
    if (base !== 'Item' && has.has(base)) return [base];
    return itemEntities(all);
  }
  if (/Terms$/.test(base)) return TERMS_ENTITIES.filter((t) => has.has(t));
  if (/(Entity|Payee|ReceiveFrom|ReceivedFrom)$/.test(base)) {
    return PARTY_ENTITIES.filter((t) => has.has(t));
  }
  if (has.has(base)) return [base];
  let best = '';
  for (const n of all) {
    if (base.endsWith(n) && n.length > best.length) best = n;
  }
  if (best) return [best];
  if (/Job$/.test(base) && has.has('Customer')) return ['Customer'];
  return [];
}
