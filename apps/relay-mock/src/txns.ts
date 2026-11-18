// Transaction semantics: defaults, line amounts, totals, sales tax, payments
// applied to invoices and bills, journal balance.
import { type EntityDef, type ObjectDef } from '@qbv/qbxml';
import type { Engine } from './engine.js';
import { childDef, field, lineFields, obj, status } from './qb.js';
import { refTo, ITEM_ENTITIES } from './refs.js';
import { type Rec } from './store.js';
import { addDays, addMonths, amt, arr, bool, cents, isObj, num, text, type Json } from './util.js';

/** Sales forms that QuickBooks numbers automatically when RefNumber is omitted. */
const AUTO_NUMBER: Record<string, number> = {
  Invoice: 1001,
  SalesReceipt: 3001,
  CreditMemo: 5001,
  Estimate: 7001,
  SalesOrder: 8001,
  PurchaseOrder: 6001,
};

export const AR_PAYMENTS = ['ReceivePayment'];
export const AP_PAYMENTS = ['BillPaymentCheck', 'BillPaymentCreditCard'];
const PAYMENTS = [...AR_PAYMENTS, ...AP_PAYMENTS];

function set(def: ObjectDef, ret: Json, name: string, value: unknown): void {
  if (field(def, name) && value !== undefined) ret[name] = value;
}

function refId(v: unknown): string | undefined {
  return isObj(v) ? text(v.ListID) : undefined;
}

// ---------------------------------------------------------------------------
// Lookups

export function itemOf(engine: Engine, line: Json): Rec | undefined {
  const id = refId(line.ItemRef);
  return id ? engine.findById(ITEM_ENTITIES(), id) : undefined;
}

/** Sales price (or purchase cost) of an item. */
export function itemPrice(item: Rec, purchase: boolean): number | undefined {
  const r = item.ret;
  const sop = isObj(r.SalesOrPurchase) ? r.SalesOrPurchase : undefined;
  const sap = isObj(r.SalesAndPurchase) ? r.SalesAndPurchase : undefined;
  if (sop) return num(sop.Price);
  if (sap) return purchase ? num(sap.PurchaseCost) : num(sap.SalesPrice);
  if (item.entity === 'ItemDiscount') {
    const rate = num(r.DiscountRate);
    return rate !== undefined ? -rate : undefined;
  }
  return purchase ? num(r.PurchaseCost) : num(r.SalesPrice);
}

function itemDesc(item: Rec, purchase: boolean): string | undefined {
  const r = item.ret;
  const sop = isObj(r.SalesOrPurchase) ? r.SalesOrPurchase : undefined;
  const sap = isObj(r.SalesAndPurchase) ? r.SalesAndPurchase : undefined;
  if (sop) return text(sop.Desc);
  if (sap) return text(purchase ? sap.PurchaseDesc : sap.SalesDesc);
  return text(purchase ? r.PurchaseDesc : (r.SalesDesc ?? r.ItemDesc));
}

export function isTaxableCode(engine: Engine, ref: unknown): boolean | undefined {
  const id = refId(ref);
  if (!id) return undefined;
  const code = engine.findById(['SalesTaxCode'], id);
  return code ? bool(code.ret.IsTaxable) : undefined;
}

function taxRate(engine: Engine, ref: unknown): number | undefined {
  const id = refId(ref);
  if (!id) return undefined;
  const t = engine.findById(['ItemSalesTax', 'ItemSalesTaxGroup'], id);
  if (!t) return undefined;
  if (t.entity === 'ItemSalesTax') return num(t.ret.TaxRate);
  let sum = 0;
  for (const r of arr<Json>(t.ret.ItemSalesTaxRef)) sum += taxRate(engine, r) ?? 0;
  return sum;
}

// ---------------------------------------------------------------------------
// Defaults

function counterpartyRef(ret: Json): unknown {
  return ret.CustomerRef ?? ret.VendorRef ?? ret.PayeeEntityRef ?? ret.EntityRef;
}

/** Fill the header fields QuickBooks fills on save (date, number, accounts, terms, due date). */
export function applyTxnDefaults(engine: Engine, e: EntityDef, ret: Json, def: ObjectDef): void {
  if (field(def, 'TxnDate') && !ret.TxnDate) ret.TxnDate = engine.today();
  if (field(def, 'TxnNumber') && !ret.TxnNumber)
    ret.TxnNumber = String(++engine.store.counters.txnNumber);
  const start = AUTO_NUMBER[e.name];
  if (start !== undefined && field(def, 'RefNumber') && !ret.RefNumber) {
    let max = start - 1;
    for (const r of engine.store.all(e.name)) {
      const n = Number(text(r.ret.RefNumber));
      if (Number.isInteger(n) && n > max) max = n;
    }
    ret.RefNumber = String(max + 1);
  }
  const acct = (name: string, rec: Rec | undefined) => {
    if (rec && field(def, name) && !ret[name]) ret[name] = refTo(rec, childDef(field(def, name)!));
  };
  if (field(def, 'ARAccountRef') && !ret.ARAccountRef) acct('ARAccountRef', engine.special('AR'));
  if (field(def, 'APAccountRef') && !ret.APAccountRef && !ret.LiabilityAccountRef)
    acct('APAccountRef', engine.special('AP'));
  if (
    field(def, 'DepositToAccountRef') &&
    !ret.DepositToAccountRef &&
    (e.name === 'ReceivePayment' || e.name === 'SalesReceipt')
  )
    acct('DepositToAccountRef', engine.special('UndepositedFunds'));

  const partyId = refId(counterpartyRef(ret));
  const party = partyId ? engine.findById(['Customer', 'Vendor'], partyId) : undefined;
  if (party) {
    if (field(def, 'TermsRef') && !ret.TermsRef && isObj(party.ret.TermsRef))
      ret.TermsRef = { ...party.ret.TermsRef };
    if (field(def, 'ItemSalesTaxRef') && !ret.ItemSalesTaxRef && isObj(party.ret.ItemSalesTaxRef))
      ret.ItemSalesTaxRef = { ...party.ret.ItemSalesTaxRef };
    if (field(def, 'SalesRepRef') && !ret.SalesRepRef && isObj(party.ret.SalesRepRef))
      ret.SalesRepRef = { ...party.ret.SalesRepRef };
    if (field(def, 'BillAddress') && !ret.BillAddress && isObj(party.ret.BillAddress))
      ret.BillAddress = { ...party.ret.BillAddress };
    if (field(def, 'VendorAddress') && !ret.VendorAddress && isObj(party.ret.VendorAddress))
      ret.VendorAddress = { ...party.ret.VendorAddress };
  }
  if (field(def, 'DueDate') && !ret.DueDate && ret.TxnDate && e.name !== 'Estimate') {
    const termsId = refId(ret.TermsRef);
    const terms = termsId
      ? engine.findById(['StandardTerms', 'DateDrivenTerms'], termsId)
      : undefined;
    const date = String(ret.TxnDate);
    if (terms?.entity === 'StandardTerms')
      ret.DueDate = addDays(date, num(terms.ret.StdDueDays) ?? 0);
    else if (terms?.entity === 'DateDrivenTerms') {
      const day = num(terms.ret.DayOfMonthDue) ?? 1;
      ret.DueDate = `${addMonths(date, 1).slice(0, 8)}${String(Math.min(day, 28)).padStart(2, '0')}`;
    } else if (['Invoice', 'Bill', 'Charge'].includes(e.name)) ret.DueDate = date;
  }
}

// ---------------------------------------------------------------------------
// Lines and totals

function isGroupDef(d: ObjectDef): boolean {
  return field(d, 'ItemGroupRef') !== undefined;
}

/** Complete one line: TxnLineID, description, rate from the item, Amount = Quantity x Rate. */
function computeLine(engine: Engine, line: Json, d: ObjectDef): void {
  if (field(d, 'TxnLineID') && !line.TxnLineID) line.TxnLineID = engine.newTxnId();
  const purchase = field(d, 'Cost') !== undefined;
  const rateKey = purchase ? 'Cost' : 'Rate';
  const item = itemOf(engine, line);
  if (item) {
    if (field(d, 'Desc') && line.Desc === undefined) {
      const desc = itemDesc(item, purchase);
      if (desc) line.Desc = desc;
    }
    if (
      line.Amount === undefined &&
      line[rateKey] === undefined &&
      line.RatePercent === undefined &&
      field(d, rateKey)
    ) {
      const p = itemPrice(item, purchase);
      if (p !== undefined && item.entity !== 'ItemDiscount') line[rateKey] = String(p);
      else if (p !== undefined) line.Amount = amt(p);
    }
  }
  if (line.Amount === undefined && field(d, 'Amount')) {
    const rate = num(line[rateKey]);
    const qty = num(line.Quantity);
    if (rate !== undefined) line.Amount = amt((qty ?? 1) * rate);
  }
}

interface LineSums {
  subtotal: number;
  taxable: number;
}

function sumLines(engine: Engine, ret: Json, def: ObjectDef, nonTaxable: boolean): LineSums {
  const sums: LineSums = { subtotal: 0, taxable: 0 };
  let running = 0; // amount since the last subtotal item
  for (const lf of lineFields(def)) {
    const ld = childDef(lf);
    const lines = arr<Json>(ret[lf.name]).filter(isObj);
    for (const line of lines) {
      if (isGroupDef(ld)) {
        expandGroup(engine, line, ld);
        const total = num(line.TotalAmount) ?? 0;
        sums.subtotal += total;
        running += total;
        const nested = lineFields(ld)[0];
        if (nested && !nonTaxable)
          for (const l of arr<Json>(line[nested.name]).filter(isObj)) {
            const item = itemOf(engine, l);
            if (
              isTaxableCode(engine, l.SalesTaxCodeRef) ??
              (item ? isTaxableCode(engine, item.ret.SalesTaxCodeRef) : false)
            )
              sums.taxable += num(l.Amount) ?? 0;
          }
        continue;
      }
      const item = itemOf(engine, line);
      if (item?.entity === 'ItemSubtotal') {
        if (field(ld, 'Amount')) line.Amount = amt(running);
        if (field(ld, 'TxnLineID') && !line.TxnLineID) line.TxnLineID = engine.newTxnId();
        running = 0;
        continue;
      }
      if (item?.entity === 'ItemDiscount' && line.Amount === undefined) {
        const pct = num(item.ret.DiscountRatePercent);
        if (pct !== undefined && line.Rate === undefined) {
          line.Amount = amt(-(running * pct) / 100);
          if (field(ld, 'RatePercent') && line.RatePercent === undefined)
            line.RatePercent = String(pct);
        }
      }
      computeLine(engine, line, ld);
      const a = num(line.Amount) ?? 0;
      sums.subtotal += a;
      running += a;
      const code = isTaxableCode(engine, line.SalesTaxCodeRef);
      const taxable =
        code ?? (item ? isTaxableCode(engine, item.ret.SalesTaxCodeRef) : false) ?? false;
      if (taxable && !nonTaxable) sums.taxable += a;
    }
  }
  sums.subtotal = cents(sums.subtotal);
  sums.taxable = cents(sums.taxable);
  return sums;
}

/** Fill a group line's member lines from the ItemGroup definition, and its TotalAmount. */
function expandGroup(engine: Engine, line: Json, gd: ObjectDef): void {
  if (field(gd, 'TxnLineID') && !line.TxnLineID) line.TxnLineID = engine.newTxnId();
  const nested = lineFields(gd)[0];
  const groupId = refId(line.ItemGroupRef);
  const group = groupId ? engine.findById(['ItemGroup'], groupId) : undefined;
  if (group) {
    if (line.IsPrintItemsInGroup === undefined)
      line.IsPrintItemsInGroup = text(group.ret.IsPrintItemsInGroup) ?? 'false';
    if (field(gd, 'Desc') && line.Desc === undefined && text(group.ret.ItemDesc))
      line.Desc = text(group.ret.ItemDesc);
  } else if (line.IsPrintItemsInGroup === undefined) line.IsPrintItemsInGroup = 'false';
  if (nested && line[nested.name] === undefined && group) {
    const qty = num(line.Quantity) ?? 1;
    line[nested.name] = arr<Json>(group.ret.ItemGroupLine).map((gl) => {
      const l: Json = { ItemRef: { ...(gl.ItemRef as Json) } };
      const q = num(gl.Quantity);
      if (q !== undefined || qty !== 1) l.Quantity = String((q ?? 1) * qty);
      return l;
    });
  }
  let total = 0;
  if (nested) {
    const nd = childDef(nested);
    for (const l of arr<Json>(line[nested.name]).filter(isObj)) {
      computeLine(engine, l, nd);
      total += num(l.Amount) ?? 0;
    }
  }
  line.TotalAmount = amt(total);
}

/** Recompute every derived amount of a transaction Ret in place. */
export function computeTotals(
  engine: Engine,
  e: EntityDef,
  rec: { key: string; ret: Json; meta: Json },
): void {
  const def = obj(e.retElement);
  const ret = rec.ret;
  if (e.name === 'JournalEntry') {
    for (const lf of lineFields(def))
      for (const l of arr<Json>(ret[lf.name]).filter(isObj))
        if (!l.TxnLineID) l.TxnLineID = engine.newTxnId();
    return;
  }
  if (e.name === 'Charge') {
    if (ret.Amount === undefined && num(ret.Rate) !== undefined)
      ret.Amount = amt((num(ret.Quantity) ?? 1) * num(ret.Rate)!);
    if (ret.Amount === undefined) {
      const item = itemOf(engine, ret);
      const p = item ? itemPrice(item, false) : undefined;
      if (p !== undefined) ret.Amount = amt((num(ret.Quantity) ?? 1) * p);
    }
  }
  const custTaxable = isTaxableCode(engine, ret.CustomerSalesTaxCodeRef);
  const sums = sumLines(engine, ret, def, custTaxable === false);
  let tax = 0;
  if (field(def, 'SalesTaxTotal')) {
    const rate = taxRate(engine, ret.ItemSalesTaxRef) ?? 0;
    tax = cents((sums.taxable * rate) / 100);
    ret.SalesTaxTotal = amt(tax);
    set(def, ret, 'SalesTaxPercentage', String(rate));
  }
  set(def, ret, 'Subtotal', amt(sums.subtotal));
  const hasLines = lineFields(def).length > 0;
  let total = cents(sums.subtotal + tax);
  if (e.name === 'Charge') total = num(ret.Amount) ?? 0;
  if (e.name === 'Transfer') total = num(ret.Amount) ?? 0;
  if (!PAYMENTS.includes(e.name) && hasLines) {
    for (const name of ['TotalAmount', 'AmountDue', 'CreditAmount', 'DepositTotal', 'Amount'])
      set(def, ret, name, amt(total));
  }
  const applied = engine.appliedTo(rec.key);
  if (e.name === 'Invoice' || e.name === 'Charge') {
    set(def, ret, 'AppliedAmount', amt(-applied.total));
    ret.BalanceRemaining = amt(total - applied.total);
    set(def, ret, 'IsPaid', String(cents(total - applied.total) <= 0));
  }
  if (e.name === 'Bill') {
    ret.OpenAmount = amt(total - applied.total);
    ret.IsPaid = String(cents(total - applied.total) <= 0);
  }
  if (e.name === 'CreditMemo') ret.CreditRemaining = amt(total);
  if (e.name === 'VendorCredit') ret.OpenAmount = amt(total);
  if (
    field(def, 'LinkedTxn') &&
    (e.name === 'Invoice' || e.name === 'Bill' || e.name === 'Charge')
  ) {
    if (applied.links.length) ret.LinkedTxn = applied.links;
    else delete ret.LinkedTxn;
  }
}

/** The total of a transaction, whichever element carries it. */
export function txnTotal(ret: Json): number {
  return (
    num(ret.TotalAmount) ??
    num(ret.AmountDue) ??
    num(ret.CreditAmount) ??
    num(ret.DepositTotal) ??
    num(ret.Amount) ??
    (num(ret.Subtotal) ?? 0) + (num(ret.SalesTaxTotal) ?? 0)
  );
}

/** Debit total and credit total of a journal entry must match. */
export function checkJournalBalance(ret: Json): void {
  let dr = 0;
  let cr = 0;
  for (const l of arr<Json>(ret.JournalDebitLine)) dr += num(l.Amount) ?? 0;
  for (const l of arr<Json>(ret.JournalCreditLine)) cr += num(l.Amount) ?? 0;
  if (cents(dr) !== cents(cr))
    throw status.saveError(
      'Journal Entry',
      'The transaction is not in balance. Make sure the amounts in the debit and credit columns are equal.',
    );
}

// ---------------------------------------------------------------------------
// Payments

interface Application {
  TxnID: string;
  PaymentAmount?: string;
  DiscountAmount?: string;
  DiscountAccountRef?: Json;
}

/**
 * Apply a payment (ReceivePayment, BillPaymentCheck, BillPaymentCreditCard)
 * to open invoices or bills. Returns the TxnIDs whose balances change.
 */
export function applyPayment(
  engine: Engine,
  e: EntityDef,
  ret: Json,
  input: Json,
  previous?: Json,
): string[] {
  const ar = AR_PAYMENTS.includes(e.name);
  const targets = ar ? ['Invoice', 'Charge'] : ['Bill'];
  const partyId = refId(ar ? ret.CustomerRef : ret.PayeeEntityRef);
  const requested = arr<Application>(input.AppliedToTxnAdd ?? input.AppliedToTxnMod);
  const def = obj(e.retElement);
  const totalField = ar ? 'TotalAmount' : 'Amount';
  const touched = new Set<string>(arr<Json>(previous?.AppliedToTxnRet).map((a) => String(a.TxnID)));
  let total = num(input[totalField]) ?? num(previous?.[totalField]);

  const open = (txn: Rec) => {
    const t =
      num(txn.ret.BalanceRemaining) ?? num(txn.ret.OpenAmount) ?? num(txn.ret.AmountDue) ?? 0;
    // Add back what this payment had applied before (Mod).
    let mine = 0;
    for (const a of arr<Json>(previous?.AppliedToTxnRet))
      if (a.TxnID === txn.key) mine += (num(a.Amount) ?? 0) + (num(a.DiscountAmount) ?? 0);
    return cents(t + mine);
  };

  const apps: { txn: Rec; amount: number; discount: number; src?: Application }[] = [];
  if (requested.length) {
    for (const a of requested) {
      const txn = engine.findTxn(a.TxnID, targets);
      if (!txn) throw status.notFound(a.TxnID);
      const party = refId(txn.ret.CustomerRef ?? txn.ret.VendorRef);
      if (partyId && party && !engine.isSameOrChild(partyId, party))
        throw status.saveError(
          e.name.replace(/([a-z])([A-Z])/g, '$1 $2'),
          `The transaction "${a.TxnID}" does not belong to this ${ar ? 'customer' : 'vendor'}.`,
        );
      const bal = open(txn);
      const discount = num(a.DiscountAmount) ?? 0;
      const amount = num(a.PaymentAmount) ?? Math.max(0, bal - discount);
      if (cents(amount + discount) > bal + 0.001)
        throw status.saveError(
          e.name.replace(/([a-z])([A-Z])/g, '$1 $2'),
          `The amount applied to transaction "${a.TxnID}" is more than its open balance.`,
        );
      apps.push({ txn, amount, discount, src: a });
    }
  } else if (bool(input.IsAutoApply) && ar && total !== undefined) {
    // QuickBooks applies to an invoice with the exact amount first, then oldest first.
    const candidates = targets
      .flatMap((t) => engine.store.all(t))
      .filter((r) => {
        const p = refId(r.ret.CustomerRef);
        return (
          p !== undefined &&
          partyId !== undefined &&
          engine.isSameOrChild(partyId, p) &&
          open(r) > 0
        );
      })
      .sort((a, b) => String(a.ret.TxnDate).localeCompare(String(b.ret.TxnDate)) || a.seq - b.seq);
    const exact = candidates.find((r) => open(r) === cents(total!));
    let left = cents(total);
    for (const r of exact ? [exact] : candidates) {
      if (left <= 0) break;
      const amount = Math.min(left, open(r));
      apps.push({ txn: r, amount, discount: 0 });
      left = cents(left - amount);
    }
  } else if (previous) {
    for (const a of arr<Json>(previous.AppliedToTxnRet)) {
      const txn = engine.findTxn(String(a.TxnID), targets);
      if (txn) apps.push({ txn, amount: num(a.Amount) ?? 0, discount: num(a.DiscountAmount) ?? 0 });
    }
  }

  const applied = cents(apps.reduce((s, a) => s + a.amount, 0));
  if (total === undefined) total = applied;
  if (applied > cents(total) + 0.001)
    throw status.saveError(
      e.name.replace(/([a-z])([A-Z])/g, '$1 $2'),
      'The total amount applied is more than the amount of the payment.',
    );
  ret[totalField] = amt(total);
  if (ar) {
    set(def, ret, 'UnusedPayment', amt(total - applied));
    set(def, ret, 'UnusedCredits', amt(0));
  }
  const appDef = childDef(field(def, 'AppliedToTxnRet')!);
  ret.AppliedToTxnRet = apps.map(({ txn, amount, discount, src }) => {
    const a: Json = {
      TxnID: txn.key,
      TxnType: txn.entity,
      TxnDate: txn.ret.TxnDate,
      RefNumber: txn.ret.RefNumber,
      BalanceRemaining: amt(open(txn) - amount - discount),
      Amount: amt(amount),
    };
    if (discount) a.DiscountAmount = amt(discount);
    if (src?.DiscountAccountRef && field(appDef, 'DiscountAccountRef'))
      a.DiscountAccountRef = src.DiscountAccountRef;
    for (const k of Object.keys(a)) if (a[k] === undefined || !field(appDef, k)) delete a[k];
    touched.add(txn.key);
    return a;
  });
  if ((ret.AppliedToTxnRet as unknown[]).length === 0) delete ret.AppliedToTxnRet;
  return [...touched];
}

/** Deposit lines that deposit a payment take its amount, account and payer. */
export function applyDepositLines(engine: Engine, ret: Json): void {
  for (const l of arr<Json>(ret.DepositLineRet).filter(isObj)) {
    if (!l.TxnLineID) l.TxnLineID = engine.newTxnId();
    const pid = text(l.TxnID);
    if (!pid) continue;
    const pay = engine.findTxn(pid, ['ReceivePayment', 'SalesReceipt']);
    if (!pay) throw status.notFound(pid);
    l.TxnID = pid;
    l.TxnType = pay.entity;
    if (l.Amount === undefined) l.Amount = pay.ret.TotalAmount;
    if (!l.EntityRef && isObj(pay.ret.CustomerRef)) l.EntityRef = { ...pay.ret.CustomerRef };
    if (!l.AccountRef && isObj(pay.ret.DepositToAccountRef))
      l.AccountRef = { ...pay.ret.DepositToAccountRef };
    if (!l.PaymentMethodRef && isObj(pay.ret.PaymentMethodRef))
      l.PaymentMethodRef = { ...pay.ret.PaymentMethodRef };
  }
}

/** Zero a voided transaction's amounts and mark its memo, as QuickBooks does. */
export function voidAmounts(def: ObjectDef, ret: Json): void {
  const zero = (o: Json, d: ObjectDef) => {
    for (const f of d.fields) {
      if (!(f.name in o)) continue;
      if (f.kind === 'simple' && f.type === 'AMTTYPE') o[f.name] = '0.00';
      if (f.kind === 'complex' && f.name !== 'LinkedTxn' && !/Ref$/.test(f.name))
        for (const c of arr<Json>(o[f.name]).filter(isObj)) zero(c, childDef(f));
    }
  };
  zero(ret, def);
  delete ret.AppliedToTxnRet;
  delete ret.LinkedTxn;
  const memo = text(ret.Memo);
  const f = field(def, 'Memo');
  if (f) {
    const m = memo ? `VOID: ${memo}` : 'VOID:';
    ret.Memo = f.maxLength !== undefined ? m.slice(0, f.maxLength) : m;
  }
}
