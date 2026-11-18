/**
 * Customer and Vendor Center configuration and helpers: which transaction
 * types belong to each center, quick actions, balances and the merged
 * transaction history of one customer or vendor.
 */
import { listObjects } from '../../transactions/lib/api';
import { dec, fmtAmount } from '../../transactions/lib/decimal';
import { formPathFor } from '../../transactions/lib/specs';
import type { ObjectRow } from '../../transactions/lib/types';

export type CenterKind = 'customer' | 'vendor';

export interface QuickAction {
  label: string;
  icon: string;
  /** Form path; the selected entity is passed as ?entity=<ListID>. */
  path: string;
}

export interface CenterConfig {
  kind: CenterKind;
  title: string;
  entityType: 'Customer' | 'Vendor';
  txnTypes: string[];
  actions: QuickAction[];
}

export const CENTERS: Record<CenterKind, CenterConfig> = {
  customer: {
    kind: 'customer',
    title: 'Customer Center',
    entityType: 'Customer',
    txnTypes: [
      'Invoice',
      'ReceivePayment',
      'SalesReceipt',
      'CreditMemo',
      'Estimate',
      'SalesOrder',
      'Charge',
    ],
    actions: [
      { label: 'New invoice', icon: 'pi pi-file', path: '/transactions/invoice/new' },
      { label: 'Receive payment', icon: 'pi pi-wallet', path: '/transactions/receive-payment/new' },
      { label: 'Sales receipt', icon: 'pi pi-receipt', path: '/transactions/sales-receipt/new' },
      { label: 'Estimate', icon: 'pi pi-calculator', path: '/transactions/estimate/new' },
      { label: 'Sales order', icon: 'pi pi-shopping-cart', path: '/transactions/sales-order/new' },
      { label: 'Credit memo', icon: 'pi pi-replay', path: '/transactions/credit-memo/new' },
      {
        label: 'Statement charge',
        icon: 'pi pi-plus-circle',
        path: '/transactions/statement-charge/new',
      },
    ],
  },
  vendor: {
    kind: 'vendor',
    title: 'Vendor Center',
    entityType: 'Vendor',
    txnTypes: [
      'Bill',
      'BillPaymentCheck',
      'BillPaymentCreditCard',
      'Check',
      'PurchaseOrder',
      'ItemReceipt',
      'VendorCredit',
      'CreditCardCharge',
      'CreditCardCredit',
    ],
    actions: [
      { label: 'Enter bill', icon: 'pi pi-file-edit', path: '/transactions/bill/new' },
      { label: 'Pay bills', icon: 'pi pi-money-bill', path: '/transactions/pay-bills' },
      { label: 'Write check', icon: 'pi pi-pencil', path: '/transactions/check/new' },
      {
        label: 'Purchase order',
        icon: 'pi pi-shopping-bag',
        path: '/transactions/purchase-order/new',
      },
      { label: 'Receive items', icon: 'pi pi-box', path: '/transactions/item-receipt/new' },
      { label: 'Vendor credit', icon: 'pi pi-undo', path: '/transactions/vendor-credit/new' },
    ],
  },
};

export function actionPath(action: QuickAction, entityId: string | undefined): string {
  if (!entityId || action.path === '/transactions/pay-bills') return action.path;
  return `${action.path}?entity=${encodeURIComponent(entityId)}`;
}

/** Display label for a catalog type: "BillPaymentCheck" -> "Bill Payment Check". */
export function typeLabel(type: string): string {
  const special: Record<string, string> = {
    Charge: 'Statement Charge',
    ReceivePayment: 'Payment',
    BillPaymentCheck: 'Bill Pmt - Check',
    BillPaymentCreditCard: 'Bill Pmt - CCard',
    ItemReceipt: 'Item Receipt',
    CreditCardCharge: 'Credit Card Charge',
    CreditCardCredit: 'Credit Card Credit',
  };
  return special[type] ?? type.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Balance of a customer (TotalBalance includes jobs) or vendor. */
export function entityBalance(row: ObjectRow): string {
  const d = row.data;
  return fmtAmount(dec(d.TotalBalance ?? d.Balance));
}

export interface TxnSummary {
  type: string;
  id: string;
  number?: string;
  date?: string;
  dueDate?: string;
  amount: string;
  /** Open balance, for documents that have one. */
  open?: string;
  memo?: string;
  path: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function txnSummary(row: ObjectRow): TxnSummary {
  const d = row.data;
  const amountSource =
    d.TotalAmount ??
    d.Amount ??
    d.AmountDue ??
    d.CreditAmount ??
    (d.Subtotal !== undefined ? fmtAmount(dec(d.Subtotal) + dec(d.SalesTaxTotal)) : undefined) ??
    row.amount;
  const openSource = d.BalanceRemaining ?? d.OpenAmount ?? d.CreditRemaining;
  return {
    type: row.type,
    id: row.id,
    number: str(d.RefNumber) ?? row.refNumber,
    date: str(d.TxnDate) ?? row.txnDate,
    dueDate: str(d.DueDate),
    amount: fmtAmount(dec(amountSource)),
    open: openSource === undefined ? undefined : fmtAmount(dec(openSource)),
    memo: str(d.Memo),
    path: formPathFor(row.type, row.id),
  };
}

/** Newest first, then by type and number. */
export function sortTxns(list: TxnSummary[]): TxnSummary[] {
  return [...list].sort(
    (a, b) =>
      (b.date ?? '').localeCompare(a.date ?? '') ||
      a.type.localeCompare(b.type) ||
      (b.number ?? '').localeCompare(a.number ?? '', undefined, { numeric: true }),
  );
}

/**
 * Recent transactions of one customer/vendor across every type of the center
 * (read model column entity_ref_id). Types the API refuses are skipped.
 */
export async function entityTransactions(
  config: CenterConfig,
  entityId: string,
  perType = 25,
): Promise<{ items: TxnSummary[]; failed: string[] }> {
  const results = await Promise.allSettled(
    config.txnTypes.map((t) =>
      listObjects(t, { filter: { entity_ref_id: entityId }, sort: '-txn_date', pageSize: perType }),
    ),
  );
  const items: TxnSummary[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value.items.map(txnSummary));
    else failed.push(config.txnTypes[i]!);
  });
  return { items: sortTxns(items), failed };
}
