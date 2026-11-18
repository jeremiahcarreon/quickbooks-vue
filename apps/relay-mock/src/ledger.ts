// General ledger postings derived from the stored transactions. Reports and
// account balances are computed from these.
import type { Engine } from './engine.js';
import { childDef, fullNameOf, lineFields, obj } from './qb.js';
import { ITEM_ENTITIES } from './refs.js';
import { type Rec } from './store.js';
import { arr, bool, cents, isObj, num, text, type Json } from './util.js';

export interface Posting {
  account: string;
  /** Debit positive, credit negative. */
  amount: number;
  date: string;
  txnId: string;
  txnType: string;
  /** Counterparty (customer / vendor / payee) display name. */
  name?: string;
}

export interface AccountInfo {
  id: string;
  name: string;
  type: string;
  number?: string;
  parent?: string;
  pseudo?: boolean;
}

export const DEBIT_TYPES = new Set([
  'Bank',
  'AccountsReceivable',
  'OtherCurrentAsset',
  'FixedAsset',
  'OtherAsset',
  'Expense',
  'OtherExpense',
  'CostOfGoodsSold',
]);
export const PL_TYPES = new Set([
  'Income',
  'OtherIncome',
  'Expense',
  'OtherExpense',
  'CostOfGoodsSold',
]);

const PSEUDO: Record<string, { name: string; type: string }> = {
  AR: { name: 'Accounts Receivable', type: 'AccountsReceivable' },
  AP: { name: 'Accounts Payable', type: 'AccountsPayable' },
  UndepositedFunds: { name: 'Undeposited Funds', type: 'OtherCurrentAsset' },
  SalesTaxPayable: { name: 'Sales Tax Payable', type: 'OtherCurrentLiability' },
  OpeningBalanceEquity: { name: 'Opening Balance Equity', type: 'Equity' },
  InventoryAsset: { name: 'Inventory Asset', type: 'OtherCurrentAsset' },
  COGS: { name: 'Cost of Goods Sold', type: 'CostOfGoodsSold' },
  UncategorizedIncome: { name: 'Uncategorized Income', type: 'Income' },
  UncategorizedExpenses: { name: 'Uncategorized Expenses', type: 'Expense' },
};

export interface Ledger {
  postings: Posting[];
  accounts: Map<string, AccountInfo>;
}

function refId(v: unknown): string | undefined {
  return isObj(v) ? text(v.ListID) : undefined;
}

export function buildLedger(engine: Engine): Ledger {
  const accounts = new Map<string, AccountInfo>();
  for (const a of engine.store.all('Account')) {
    accounts.set(a.key, {
      id: a.key,
      name: fullNameOf(a.ret) ?? a.key,
      type: text(a.ret.AccountType) ?? 'OtherAsset',
      number: text(a.ret.AccountNumber),
      parent: refId(a.ret.ParentRef),
    });
  }
  const pseudo = (k: keyof typeof PSEUDO): string => {
    const id = `pseudo:${k}`;
    if (!accounts.has(id)) accounts.set(id, { id, ...PSEUDO[k]!, pseudo: true });
    return id;
  };
  const special = (k: Parameters<Engine['special']>[0], fallback: keyof typeof PSEUDO) =>
    engine.special(k)?.key ?? pseudo(fallback);
  const acct = (ref: unknown, fallback: () => string): string => {
    const id = refId(ref);
    return id && accounts.has(id) ? id : fallback();
  };

  const postings: Posting[] = [];
  const post = (account: string, amount: number, rec: Rec, date: string, name?: string) => {
    const a = cents(amount);
    if (a === 0) return;
    postings.push({ account, amount: a, date, txnId: rec.key, txnType: rec.entity, name });
  };

  const itemAccounts = (item: Rec | undefined) => {
    const r = item?.ret ?? {};
    const sop = isObj(r.SalesOrPurchase) ? r.SalesOrPurchase : undefined;
    const sap = isObj(r.SalesAndPurchase) ? r.SalesAndPurchase : undefined;
    return {
      income:
        refId(sop?.AccountRef) ??
        refId(sap?.IncomeAccountRef) ??
        refId(r.IncomeAccountRef) ??
        refId(r.AccountRef),
      expense:
        refId(sop?.AccountRef) ?? refId(sap?.ExpenseAccountRef) ?? refId(r.ExpenseAccountRef),
      cogs: refId(r.COGSAccountRef),
      asset: refId(r.AssetAccountRef),
      cost: num(r.PurchaseCost) ?? num(sap?.PurchaseCost),
      salesTax: item?.entity === 'ItemSalesTax' || item?.entity === 'ItemSalesTaxGroup',
      subtotal: item?.entity === 'ItemSubtotal',
    };
  };
  const itemOf = (line: Json) => {
    const id = refId(line.ItemRef);
    return id ? engine.findById(ITEM_ENTITIES(), id) : undefined;
  };

  /** Every non-group line of a transaction (group members included). */
  const linesOf = (rec: Rec, kind?: RegExp): Json[] => {
    const def = obj(engine.entityOf(rec.entity).retElement);
    const out: Json[] = [];
    for (const lf of lineFields(def)) {
      if (kind && !kind.test(lf.name)) continue;
      const ld = childDef(lf);
      for (const l of arr<Json>(rec.ret[lf.name]).filter(isObj)) {
        const nested = lineFields(ld)[0];
        if (nested && 'ItemGroupRef' in l) out.push(...arr<Json>(l[nested.name]).filter(isObj));
        else out.push(l);
      }
    }
    return out;
  };

  const salesLines = (rec: Rec, sign: 1 | -1, date: string, name?: string) => {
    for (const l of linesOf(rec)) {
      const amount = num(l.Amount) ?? 0;
      const item = itemOf(l);
      const ia = itemAccounts(item);
      if (ia.subtotal) continue;
      const income = acct(
        l.OverrideItemAccountRef ?? (ia.income ? { ListID: ia.income } : undefined),
        () =>
          ia.salesTax
            ? special('SalesTaxPayable', 'SalesTaxPayable')
            : pseudo('UncategorizedIncome'),
      );
      post(income, -sign * amount, rec, date, name);
      const qty = num(l.Quantity) ?? 0;
      if (ia.cogs && ia.asset && ia.cost !== undefined && qty) {
        post(
          acct({ ListID: ia.cogs }, () => special('COGS', 'COGS')),
          sign * qty * ia.cost,
          rec,
          date,
          name,
        );
        post(
          acct({ ListID: ia.asset }, () => special('InventoryAsset', 'InventoryAsset')),
          -sign * qty * ia.cost,
          rec,
          date,
          name,
        );
      }
    }
  };

  const purchaseLines = (rec: Rec, sign: 1 | -1, date: string, name?: string) => {
    for (const l of linesOf(rec)) {
      const amount = num(l.Amount) ?? 0;
      if (l.ItemRef === undefined && l.AccountRef !== undefined) {
        post(
          acct(l.AccountRef, () => pseudo('UncategorizedExpenses')),
          sign * amount,
          rec,
          date,
          name,
        );
        continue;
      }
      const ia = itemAccounts(itemOf(l));
      if (ia.subtotal) continue;
      const target = ia.asset ?? ia.expense ?? ia.cogs;
      post(
        acct(l.OverrideItemAccountRef ?? (target ? { ListID: target } : undefined), () =>
          pseudo('UncategorizedExpenses'),
        ),
        sign * amount,
        rec,
        date,
        name,
      );
    }
  };

  // Opening balances of accounts, customers and vendors.
  for (const a of engine.store.all('Account')) {
    const ob = num(a.meta.openBalance);
    if (!ob) continue;
    const type = text(a.ret.AccountType) ?? '';
    const date = text(a.meta.openBalanceDate) ?? engine.today();
    const sign = DEBIT_TYPES.has(type) ? 1 : -1;
    post(a.key, sign * ob, a, date);
    post(special('OpeningBalanceEquity', 'OpeningBalanceEquity'), -sign * ob, a, date);
  }
  for (const c of engine.store.all('Customer')) {
    const ob = num(c.meta.openBalance);
    if (!ob) continue;
    const date = text(c.meta.openBalanceDate) ?? engine.today();
    post(special('AR', 'AR'), ob, c, date, fullNameOf(c.ret));
    post(pseudo('UncategorizedIncome'), -ob, c, date, fullNameOf(c.ret));
  }
  for (const v of engine.store.all('Vendor')) {
    const ob = num(v.meta.openBalance);
    if (!ob) continue;
    const date = text(v.meta.openBalanceDate) ?? engine.today();
    post(special('AP', 'AP'), -ob, v, date, fullNameOf(v.ret));
    post(pseudo('UncategorizedExpenses'), ob, v, date, fullNameOf(v.ret));
  }

  for (const rec of engine.store.each()) {
    const r = rec.ret;
    const date = text(r.TxnDate) ?? engine.today();
    const party = isObj(r.CustomerRef ?? r.VendorRef ?? r.PayeeEntityRef)
      ? text(((r.CustomerRef ?? r.VendorRef ?? r.PayeeEntityRef) as Json).FullName)
      : undefined;
    const ar = () => acct(r.ARAccountRef, () => special('AR', 'AR'));
    const ap = () => acct(r.APAccountRef, () => special('AP', 'AP'));
    const stp = () => special('SalesTaxPayable', 'SalesTaxPayable');
    const uf = () => special('UndepositedFunds', 'UndepositedFunds');
    switch (rec.entity) {
      case 'Invoice':
        if (bool(r.IsPending)) break;
        post(ar(), (num(r.Subtotal) ?? 0) + (num(r.SalesTaxTotal) ?? 0), rec, date, party);
        salesLines(rec, 1, date, party);
        post(stp(), -(num(r.SalesTaxTotal) ?? 0), rec, date, party);
        break;
      case 'SalesReceipt':
        post(acct(r.DepositToAccountRef, uf), num(r.TotalAmount) ?? 0, rec, date, party);
        salesLines(rec, 1, date, party);
        post(stp(), -(num(r.SalesTaxTotal) ?? 0), rec, date, party);
        break;
      case 'CreditMemo':
        post(ar(), -(num(r.TotalAmount) ?? 0), rec, date, party);
        salesLines(rec, -1, date, party);
        post(stp(), num(r.SalesTaxTotal) ?? 0, rec, date, party);
        break;
      case 'Charge': {
        post(ar(), num(r.Amount) ?? 0, rec, date, party);
        const ia = itemAccounts(itemOf(r));
        post(
          acct(ia.income ? { ListID: ia.income } : undefined, () => pseudo('UncategorizedIncome')),
          -(num(r.Amount) ?? 0),
          rec,
          date,
          party,
        );
        break;
      }
      case 'ReceivePayment':
        post(acct(r.DepositToAccountRef, uf), num(r.TotalAmount) ?? 0, rec, date, party);
        post(ar(), -(num(r.TotalAmount) ?? 0), rec, date, party);
        break;
      case 'Deposit':
        post(acct(r.DepositToAccountRef, uf), num(r.DepositTotal) ?? 0, rec, date);
        for (const l of arr<Json>(r.DepositLineRet))
          post(
            acct(l.AccountRef, uf),
            -(num(l.Amount) ?? 0),
            rec,
            date,
            isObj(l.EntityRef) ? text(l.EntityRef.FullName) : undefined,
          );
        break;
      case 'Bill':
        post(ap(), -(num(r.AmountDue) ?? 0), rec, date, party);
        purchaseLines(rec, 1, date, party);
        break;
      case 'ItemReceipt':
        post(
          acct(r.APAccountRef ?? r.LiabilityAccountRef, () => special('AP', 'AP')),
          -(num(r.TotalAmount) ?? 0),
          rec,
          date,
          party,
        );
        purchaseLines(rec, 1, date, party);
        break;
      case 'VendorCredit':
        post(ap(), num(r.CreditAmount) ?? 0, rec, date, party);
        purchaseLines(rec, -1, date, party);
        break;
      case 'Check':
      case 'CreditCardCharge':
        post(
          acct(r.AccountRef, () => pseudo('UncategorizedExpenses')),
          -(num(r.Amount) ?? 0),
          rec,
          date,
          party,
        );
        purchaseLines(rec, 1, date, party);
        break;
      case 'CreditCardCredit':
        post(
          acct(r.AccountRef, () => pseudo('UncategorizedExpenses')),
          num(r.Amount) ?? 0,
          rec,
          date,
          party,
        );
        purchaseLines(rec, -1, date, party);
        break;
      case 'BillPaymentCheck':
        post(ap(), num(r.Amount) ?? 0, rec, date, party);
        post(
          acct(r.BankAccountRef, () => pseudo('UncategorizedExpenses')),
          -(num(r.Amount) ?? 0),
          rec,
          date,
          party,
        );
        break;
      case 'BillPaymentCreditCard':
        post(ap(), num(r.Amount) ?? 0, rec, date, party);
        post(
          acct(r.CreditCardAccountRef, () => pseudo('UncategorizedExpenses')),
          -(num(r.Amount) ?? 0),
          rec,
          date,
          party,
        );
        break;
      case 'SalesTaxPaymentCheck':
        post(stp(), num(r.Amount) ?? 0, rec, date, party);
        post(
          acct(r.BankAccountRef, () => pseudo('UncategorizedExpenses')),
          -(num(r.Amount) ?? 0),
          rec,
          date,
          party,
        );
        break;
      case 'Transfer':
        post(
          acct(r.TransferToAccountRef, () => pseudo('UncategorizedExpenses')),
          num(r.Amount) ?? 0,
          rec,
          date,
        );
        post(
          acct(r.TransferFromAccountRef, () => pseudo('UncategorizedExpenses')),
          -(num(r.Amount) ?? 0),
          rec,
          date,
        );
        break;
      case 'JournalEntry':
        for (const l of arr<Json>(r.JournalDebitLine))
          post(
            acct(l.AccountRef, () => pseudo('UncategorizedExpenses')),
            num(l.Amount) ?? 0,
            rec,
            date,
            isObj(l.EntityRef) ? text(l.EntityRef.FullName) : undefined,
          );
        for (const l of arr<Json>(r.JournalCreditLine))
          post(
            acct(l.AccountRef, () => pseudo('UncategorizedExpenses')),
            -(num(l.Amount) ?? 0),
            rec,
            date,
            isObj(l.EntityRef) ? text(l.EntityRef.FullName) : undefined,
          );
        break;
    }
  }
  return { postings, accounts };
}

/** Balance of each account in its natural sign over postings matching `pred`. */
export function balances(ledger: Ledger, pred: (p: Posting) => boolean): Map<string, number> {
  const raw = new Map<string, number>();
  for (const p of ledger.postings)
    if (pred(p)) raw.set(p.account, (raw.get(p.account) ?? 0) + p.amount);
  const out = new Map<string, number>();
  for (const [id, v] of raw) {
    const type = ledger.accounts.get(id)?.type ?? 'Expense';
    out.set(id, cents(DEBIT_TYPES.has(type) ? v : -v));
  }
  return out;
}
