/**
 * Payment application for Receive Payment (customer invoices) and Pay Bills
 * (vendor bills): open documents, applying an amount oldest-first, discounts
 * and credits, and the AppliedToTxnAdd/Mod bodies.
 */
import { add, dec, fmtAmount, max, min, parseDec, sub, sum, ZERO, type Dec } from './decimal';
import { refIn, refOut } from './refs';
import type { ObjectRow, RefValue } from './types';

type Json = Record<string, unknown>;

/** An open invoice/bill/charge that a payment can be applied to. */
export interface OpenDoc {
  TxnID: string;
  type: string;
  RefNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  /** Original amount of the document. */
  original: string;
  /** Amount still open (before this payment). */
  balance: string;
  suggestedDiscount?: string;
  suggestedDiscountDate?: string;
  entity?: RefValue | null;
}

/** An available credit (credit memo / vendor credit). */
export interface CreditDoc {
  TxnID: string;
  type: string;
  RefNumber?: string;
  TxnDate?: string;
  available: string;
}

export interface CreditUse {
  CreditTxnID: string;
  AppliedAmount: string;
}

/** What the user applied to one open document. */
export interface Application {
  TxnID: string;
  selected: boolean;
  payment: string;
  discount: string;
  credits: CreditUse[];
}

const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function firstAmount(...vals: unknown[]): string {
  for (const v of vals) {
    const d = parseDec(v);
    if (d !== null) return fmtAmount(d);
  }
  return '0.00';
}

/** Open document from an Invoice/Charge/Bill row. */
export function openDocFromRow(row: ObjectRow): OpenDoc {
  const d = row.data;
  const isBill = row.type === 'Bill';
  return {
    TxnID: s(d.TxnID) || row.id,
    type: row.type,
    RefNumber: s(d.RefNumber) || undefined,
    TxnDate: s(d.TxnDate) || undefined,
    DueDate: s(d.DueDate) || undefined,
    original: isBill
      ? firstAmount(d.AmountDue, row.amount)
      : row.type === 'Charge'
        ? firstAmount(d.Amount, row.amount)
        : firstAmount(
            parseDec(d.Subtotal) !== null
              ? fmtAmount(add(dec(d.Subtotal), dec(d.SalesTaxTotal)))
              : undefined,
            row.amount,
          ),
    balance: isBill
      ? firstAmount(d.OpenAmount, d.AmountDue)
      : firstAmount(d.BalanceRemaining, d.Amount),
    suggestedDiscount:
      parseDec(d.SuggestedDiscountAmount) !== null ? s(d.SuggestedDiscountAmount) : undefined,
    suggestedDiscountDate: s(d.SuggestedDiscountDate) || undefined,
    entity: refIn(d.CustomerRef ?? d.VendorRef),
  };
}

export function creditDocFromRow(row: ObjectRow): CreditDoc {
  const d = row.data;
  return {
    TxnID: s(d.TxnID) || row.id,
    type: row.type,
    RefNumber: s(d.RefNumber) || undefined,
    TxnDate: s(d.TxnDate) || undefined,
    available: firstAmount(d.CreditRemaining, d.OpenAmount, d.CreditAmount, d.TotalAmount),
  };
}

/** Oldest first: due date, then transaction date, then ref number. */
export function sortOpenDocs<T extends OpenDoc>(docs: readonly T[]): T[] {
  const key = (d: OpenDoc) => d.DueDate ?? d.TxnDate ?? '9999-12-31';
  return [...docs].sort(
    (a, b) =>
      key(a).localeCompare(key(b)) ||
      (a.TxnDate ?? '').localeCompare(b.TxnDate ?? '') ||
      (a.RefNumber ?? '').localeCompare(b.RefNumber ?? '', undefined, { numeric: true }),
  );
}

export function emptyApplication(TxnID: string): Application {
  return { TxnID, selected: false, payment: '', discount: '', credits: [] };
}

function creditsTotal(a: Application): Dec {
  return sum(a.credits, (c) => dec(c.AppliedAmount));
}

/** What is still owed on a document after this application's discount and credits. */
export function remainingAfterReductions(doc: OpenDoc, a: Application | undefined): Dec {
  if (!a) return dec(doc.balance);
  return sub(sub(dec(doc.balance), dec(a.discount)), creditsTotal(a));
}

/**
 * Spread `amount` over the documents oldest-first, after their discounts and
 * credits. Documents that get nothing are deselected (unless they carry a
 * discount or credit). Returns new applications; leftover is unapplied.
 */
export function autoApply(
  docs: readonly OpenDoc[],
  apps: Record<string, Application>,
  amount: Dec,
): { apps: Record<string, Application>; unapplied: Dec } {
  let left = max(amount, ZERO);
  const out: Record<string, Application> = {};
  for (const doc of sortOpenDocs(docs)) {
    const prev = apps[doc.TxnID] ?? emptyApplication(doc.TxnID);
    const owed = max(remainingAfterReductions(doc, prev), ZERO);
    const pay = min(owed, left);
    left = sub(left, pay);
    const hasReductions = dec(prev.discount) > ZERO || prev.credits.length > 0;
    out[doc.TxnID] = {
      ...prev,
      payment: pay > ZERO ? fmtAmount(pay) : '',
      selected: pay > ZERO || hasReductions,
    };
  }
  return { apps: out, unapplied: left };
}

/** Select a document and pay what is left on it (the checkbox in the grid). */
export function toggleDoc(doc: OpenDoc, app: Application | undefined, on: boolean): Application {
  const a = app ?? emptyApplication(doc.TxnID);
  if (!on) return { ...a, selected: false, payment: '', discount: '', credits: [] };
  const owed = max(remainingAfterReductions(doc, a), ZERO);
  return { ...a, selected: true, payment: fmtAmount(owed) };
}

/**
 * Apply available credits to a document, largest need first, never using
 * more of a credit than remains across all applications.
 */
export function applyCredits(
  doc: OpenDoc,
  app: Application,
  credits: readonly CreditDoc[],
  allApps: Record<string, Application>,
): Application {
  const used = new Map<string, Dec>();
  for (const a of Object.values(allApps)) {
    if (a.TxnID === doc.TxnID) continue;
    for (const c of a.credits)
      used.set(c.CreditTxnID, add(used.get(c.CreditTxnID) ?? ZERO, dec(c.AppliedAmount)));
  }
  let owed = max(sub(dec(doc.balance), dec(app.discount)), ZERO);
  const uses: CreditUse[] = [];
  for (const c of credits) {
    if (owed === ZERO) break;
    const avail = sub(dec(c.available), used.get(c.TxnID) ?? ZERO);
    if (avail <= ZERO) continue;
    const take = min(avail, owed);
    uses.push({ CreditTxnID: c.TxnID, AppliedAmount: fmtAmount(take) });
    owed = sub(owed, take);
  }
  const payment = min(dec(app.payment), owed);
  return {
    ...app,
    selected: true,
    credits: uses,
    payment: payment > ZERO ? fmtAmount(payment) : '',
  };
}

export interface PaymentSummary {
  applied: Dec;
  discounts: Dec;
  credits: Dec;
  /** Total amount received/paid (the typed total, or the applied sum when blank). */
  total: Dec;
  /** total - applied: kept as an unapplied credit (customer) or rejected (bills). */
  unapplied: Dec;
  issues: string[];
}

export function summarize(
  docs: readonly OpenDoc[],
  apps: Record<string, Application>,
  typedTotal: string,
  opts: {
    creditDocs?: readonly CreditDoc[];
    discountAccount?: unknown;
    requireExact?: boolean;
  } = {},
): PaymentSummary {
  const issues: string[] = [];
  const active = docs.map((d) => ({ d, a: apps[d.TxnID] })).filter(({ a }) => a?.selected);
  const applied = sum(active, ({ a }) => dec(a!.payment));
  const discounts = sum(active, ({ a }) => dec(a!.discount));
  const credits = sum(active, ({ a }) => creditsTotal(a!));
  for (const { d, a } of active) {
    const label = d.RefNumber ? `#${d.RefNumber}` : d.TxnID;
    for (const [name, v] of [
      ['Payment', a!.payment],
      ['Discount', a!.discount],
    ] as const) {
      if (v.trim() && parseDec(v) === null) issues.push(`${label}: ${name} is not a number.`);
      else if (dec(v) < ZERO) issues.push(`${label}: ${name} cannot be negative.`);
    }
    if (sub(sub(sub(dec(d.balance), dec(a!.payment)), dec(a!.discount)), creditsTotal(a!)) < ZERO) {
      issues.push(`${label}: payment, discount and credits exceed the open balance.`);
    }
  }
  if (discounts > ZERO && !refOut(opts.discountAccount)) {
    issues.push('Choose a discount account for the discounts.');
  }
  if (opts.creditDocs) {
    const usedByCredit = new Map<string, Dec>();
    for (const { a } of active) {
      for (const c of a!.credits)
        usedByCredit.set(
          c.CreditTxnID,
          add(usedByCredit.get(c.CreditTxnID) ?? ZERO, dec(c.AppliedAmount)),
        );
    }
    for (const [id, used] of usedByCredit) {
      const c = opts.creditDocs.find((x) => x.TxnID === id);
      if (c && used > dec(c.available))
        issues.push(`Credit ${c.RefNumber ?? id} is applied beyond its remaining amount.`);
    }
  }
  const typed = typedTotal.trim() ? parseDec(typedTotal) : null;
  if (typedTotal.trim() && typed === null) issues.push('The amount is not a number.');
  const total = typed ?? applied;
  const unapplied = sub(total, applied);
  if (unapplied < ZERO)
    issues.push(`Applied amounts (${fmtAmount(applied)}) exceed the amount (${fmtAmount(total)}).`);
  if (opts.requireExact && unapplied !== ZERO && unapplied > ZERO) {
    issues.push('The payment amount must equal the amounts applied.');
  }
  return { applied, discounts, credits, total, unapplied, issues };
}

/** AppliedToTxnAdd / AppliedToTxnMod entries in schema order. */
export function appliedBodies(
  docs: readonly OpenDoc[],
  apps: Record<string, Application>,
  discountAccount: unknown,
): Json[] {
  const acct = refOut(discountAccount);
  return docs
    .map((d) => apps[d.TxnID])
    .filter((a): a is Application => !!a && a.selected)
    .filter((a) => dec(a.payment) > ZERO || dec(a.discount) > ZERO || a.credits.length > 0)
    .map((a) => {
      const out: Json = { TxnID: a.TxnID };
      // PaymentAmount is optional; QuickBooks treats it as 0 when omitted.
      out.PaymentAmount = fmtAmount(dec(a.payment));
      const credits = a.credits.filter((c) => dec(c.AppliedAmount) > ZERO);
      if (credits.length)
        out.SetCredit = credits.map((c) => ({
          CreditTxnID: c.CreditTxnID,
          AppliedAmount: fmtAmount(dec(c.AppliedAmount)),
        }));
      if (dec(a.discount) > ZERO) {
        out.DiscountAmount = fmtAmount(dec(a.discount));
        if (acct) out.DiscountAccountRef = acct;
      }
      return out;
    });
}

// ---------------------------------------------------------------------------
// Receive Payment

export interface ReceivePaymentState {
  TxnID?: string;
  EditSequence?: string;
  CustomerRef: RefValue | null;
  ARAccountRef: RefValue | null;
  TxnDate: string;
  RefNumber: string;
  TotalAmount: string;
  PaymentMethodRef: RefValue | null;
  Memo: string;
  DepositToAccountRef: RefValue | null;
  DiscountAccountRef: RefValue | null;
  /** With no applications: let QuickBooks auto-apply (true) or leave unapplied (false). */
  autoApply: boolean;
  apps: Record<string, Application>;
}

function header(state: ReceivePaymentState, total: Dec): Json {
  const out: Json = {};
  const cust = refOut(state.CustomerRef);
  if (cust) out.CustomerRef = cust;
  const ar = refOut(state.ARAccountRef);
  if (ar) out.ARAccountRef = ar;
  if (state.TxnDate) out.TxnDate = state.TxnDate;
  if (state.RefNumber.trim()) out.RefNumber = state.RefNumber.trim();
  out.TotalAmount = fmtAmount(total);
  const pm = refOut(state.PaymentMethodRef);
  if (pm) out.PaymentMethodRef = pm;
  if (state.Memo.trim()) out.Memo = state.Memo.trim();
  const dep = refOut(state.DepositToAccountRef);
  if (dep) out.DepositToAccountRef = dep;
  return out;
}

export class PaymentError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join(' '));
    this.name = 'PaymentError';
  }
}

export function receivePaymentAddBody(
  state: ReceivePaymentState,
  docs: readonly OpenDoc[],
  creditDocs: readonly CreditDoc[] = [],
): Json {
  const sumry = summarize(docs, state.apps, state.TotalAmount, {
    creditDocs,
    discountAccount: state.DiscountAccountRef,
  });
  const issues = [...sumry.issues];
  if (!refOut(state.CustomerRef)) issues.unshift('Choose a customer.');
  if (issues.length) throw new PaymentError(issues);
  const out = header(state, sumry.total);
  const applied = appliedBodies(docs, state.apps, state.DiscountAccountRef);
  if (applied.length) out.AppliedToTxnAdd = applied;
  else out.IsAutoApply = state.autoApply ? 'true' : 'false';
  return out;
}

export function receivePaymentModBody(
  state: ReceivePaymentState,
  docs: readonly OpenDoc[],
  creditDocs: readonly CreditDoc[] = [],
): Json {
  if (!state.TxnID || !state.EditSequence) throw new Error('TxnID and EditSequence are required.');
  const sumry = summarize(docs, state.apps, state.TotalAmount, {
    creditDocs,
    discountAccount: state.DiscountAccountRef,
  });
  if (sumry.issues.length) throw new PaymentError(sumry.issues);
  const out: Json = {
    TxnID: state.TxnID,
    EditSequence: state.EditSequence,
    ...header(state, sumry.total),
  };
  const applied = appliedBodies(docs, state.apps, state.DiscountAccountRef);
  if (applied.length) out.AppliedToTxnMod = applied;
  return out;
}

function arr(v: unknown): Json[] {
  if (Array.isArray(v)) return v as Json[];
  if (v && typeof v === 'object') return [v as Json];
  return [];
}

/**
 * Load a ReceivePaymentRet: header plus its current applications. The
 * invoices it pays are returned as open docs whose balance includes what
 * this payment already covers, so they can be re-applied.
 */
export function receivePaymentFromRet(ret: Json): {
  state: ReceivePaymentState;
  appliedDocs: OpenDoc[];
} {
  const apps: Record<string, Application> = {};
  const appliedDocs: OpenDoc[] = [];
  let discountAccount: RefValue | null = null;
  for (const a of arr(ret.AppliedToTxnRet)) {
    const id = s(a.TxnID);
    if (!id) continue;
    const paid = dec(a.Amount);
    const disc = dec(a.DiscountAmount);
    apps[id] = {
      TxnID: id,
      selected: true,
      payment: fmtAmount(paid),
      discount: disc > ZERO ? fmtAmount(disc) : '',
      credits: [],
    };
    discountAccount = discountAccount ?? refIn(a.DiscountAccountRef);
    appliedDocs.push({
      TxnID: id,
      type: s(a.TxnType) || 'Invoice',
      RefNumber: s(a.RefNumber) || undefined,
      TxnDate: s(a.TxnDate) || undefined,
      original: firstAmount(a.BalanceRemaining),
      balance: fmtAmount(add(dec(a.BalanceRemaining), paid, disc)),
    });
  }
  return {
    state: {
      TxnID: s(ret.TxnID) || undefined,
      EditSequence: s(ret.EditSequence) || undefined,
      CustomerRef: refIn(ret.CustomerRef),
      ARAccountRef: refIn(ret.ARAccountRef),
      TxnDate: s(ret.TxnDate),
      RefNumber: s(ret.RefNumber),
      TotalAmount: s(ret.TotalAmount),
      PaymentMethodRef: refIn(ret.PaymentMethodRef),
      Memo: s(ret.Memo),
      DepositToAccountRef: refIn(ret.DepositToAccountRef),
      DiscountAccountRef: discountAccount,
      autoApply: false,
      apps,
    },
    appliedDocs,
  };
}

/** Merge open docs from the read model with docs this payment already covers. */
export function mergeDocs(open: readonly OpenDoc[], applied: readonly OpenDoc[]): OpenDoc[] {
  const byId = new Map<string, OpenDoc>();
  for (const d of open) byId.set(d.TxnID, d);
  for (const d of applied) {
    const o = byId.get(d.TxnID);
    // The read model's open balance already excludes this payment; use the larger figure.
    byId.set(d.TxnID, o ? { ...o, balance: fmtAmount(max(dec(o.balance), dec(d.balance))) } : d);
  }
  return sortOpenDocs([...byId.values()]);
}

// ---------------------------------------------------------------------------
// Pay Bills

export interface PayBillsState {
  TxnDate: string;
  method: 'check' | 'creditcard';
  BankAccountRef: RefValue | null;
  CreditCardAccountRef: RefValue | null;
  APAccountRef: RefValue | null;
  /** Checks: print later (IsToBePrinted) or assign numbers starting at firstCheckNumber. */
  toBePrinted: boolean;
  firstCheckNumber: string;
  Memo: string;
  DiscountAccountRef: RefValue | null;
  apps: Record<string, Application>;
}

export interface BillPaymentRequest {
  type: 'BillPaymentCheck' | 'BillPaymentCreditCard';
  vendor: RefValue;
  amount: Dec;
  body: Json;
}

function nextCheckNumber(first: string, offset: number): string {
  const m = /^(.*?)(\d+)$/.exec(first.trim());
  if (!m) return offset === 0 ? first.trim() : `${first.trim()}-${offset + 1}`;
  const n = (BigInt(m[2]!) + BigInt(offset)).toString().padStart(m[2]!.length, '0');
  return `${m[1]}${n}`;
}

/** One bill payment per vendor, as QuickBooks' Pay Bills window creates. */
export function payBillsBodies(
  state: PayBillsState,
  bills: readonly OpenDoc[],
  creditDocs: readonly CreditDoc[] = [],
): BillPaymentRequest[] {
  const sumry = summarize(bills, state.apps, '', {
    creditDocs,
    discountAccount: state.DiscountAccountRef,
  });
  const issues = [...sumry.issues];
  const selected = bills.filter((b) => state.apps[b.TxnID]?.selected);
  if (selected.length === 0) issues.push('Select at least one bill to pay.');
  if (state.method === 'check' && !refOut(state.BankAccountRef))
    issues.push('Choose the bank account to pay from.');
  if (state.method === 'creditcard' && !refOut(state.CreditCardAccountRef))
    issues.push('Choose the credit card account.');
  if (state.method === 'check' && !state.toBePrinted && !state.firstCheckNumber.trim()) {
    issues.push('Enter the first check number, or choose "To be printed".');
  }
  const groups = new Map<string, { vendor: RefValue; docs: OpenDoc[] }>();
  for (const b of selected) {
    const v = b.entity;
    if (!v || !refOut(v)) {
      issues.push(`Bill ${b.RefNumber ?? b.TxnID} has no vendor.`);
      continue;
    }
    const key = v.ListID ?? v.FullName ?? '';
    const g = groups.get(key) ?? { vendor: v, docs: [] };
    g.docs.push(b);
    groups.set(key, g);
  }
  if (issues.length) throw new PaymentError(issues);
  const vendors = [...groups.values()].sort((a, b) =>
    (a.vendor.FullName ?? '').localeCompare(b.vendor.FullName ?? ''),
  );
  return vendors.map((g, i) => {
    const applied = appliedBodies(g.docs, state.apps, state.DiscountAccountRef);
    const amount = sum(g.docs, (d) => dec(state.apps[d.TxnID]?.payment));
    const out: Json = { PayeeEntityRef: refOut(g.vendor) };
    const ap = refOut(state.APAccountRef);
    if (ap) out.APAccountRef = ap;
    if (state.TxnDate) out.TxnDate = state.TxnDate;
    if (state.method === 'check') {
      out.BankAccountRef = refOut(state.BankAccountRef);
      if (state.toBePrinted) out.IsToBePrinted = 'true';
      else out.RefNumber = nextCheckNumber(state.firstCheckNumber, i);
    } else {
      out.CreditCardAccountRef = refOut(state.CreditCardAccountRef);
    }
    if (state.Memo.trim()) out.Memo = state.Memo.trim();
    out.AppliedToTxnAdd = applied;
    return {
      type: state.method === 'check' ? 'BillPaymentCheck' : 'BillPaymentCreditCard',
      vendor: g.vendor,
      amount,
      body: out,
    };
  });
}

export { nextCheckNumber };
