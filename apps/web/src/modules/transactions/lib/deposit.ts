/**
 * Make Deposits: payments held in Undeposited Funds plus free-form lines
 * (received from / from account / amount).
 */
import { dec, fmtAmount, parseDec, sum, ZERO, type Dec } from './decimal';
import { refIn, refOut } from './refs';
import type { ObjectRow, RefValue } from './types';

type Json = Record<string, unknown>;

export interface DepositPayment {
  /** TxnID of the ReceivePayment / SalesReceipt. */
  TxnID: string;
  type: string;
  TxnDate?: string;
  RefNumber?: string;
  entity?: RefValue | null;
  paymentMethod?: RefValue | null;
  amount: string;
  selected: boolean;
}

export interface DepositLine {
  key: string;
  TxnLineID?: string;
  /** Set on lines loaded from an existing deposit that came from a payment. */
  paymentTxnID?: string;
  EntityRef: RefValue | null;
  AccountRef: RefValue | null;
  Memo: string;
  CheckNumber: string;
  PaymentMethodRef: RefValue | null;
  ClassRef: RefValue | null;
  Amount: string;
}

export interface DepositState {
  TxnID?: string;
  EditSequence?: string;
  TxnDate: string;
  DepositToAccountRef: RefValue | null;
  Memo: string;
  payments: DepositPayment[];
  lines: DepositLine[];
}

const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

let seq = 0;
export function blankDepositLine(): DepositLine {
  seq += 1;
  return {
    key: `d${seq}`,
    EntityRef: null,
    AccountRef: null,
    Memo: '',
    CheckNumber: '',
    PaymentMethodRef: null,
    ClassRef: null,
    Amount: '',
  };
}

export function isBlankDepositLine(l: DepositLine): boolean {
  return (
    !l.paymentTxnID &&
    !refOut(l.AccountRef) &&
    parseDec(l.Amount) === null &&
    !l.Memo.trim() &&
    !refOut(l.EntityRef)
  );
}

export function depositPaymentFromRow(row: ObjectRow): DepositPayment {
  const d = row.data;
  return {
    TxnID: s(d.TxnID) || row.id,
    type: row.type,
    TxnDate: s(d.TxnDate) || undefined,
    RefNumber: s(d.RefNumber) || s(d.CheckNumber) || undefined,
    entity: refIn(d.CustomerRef),
    paymentMethod: refIn(d.PaymentMethodRef),
    amount: fmtAmount(dec(d.TotalAmount ?? row.amount)),
    selected: false,
  };
}

export function depositTotal(state: DepositState): Dec {
  const payments = sum(
    state.payments.filter((p) => p.selected),
    (p) => dec(p.amount),
  );
  const lines = sum(
    state.lines.filter((l) => !isBlankDepositLine(l)),
    (l) => dec(l.Amount),
  );
  return payments + lines;
}

export function depositIssues(state: DepositState): string[] {
  const issues: string[] = [];
  if (!refOut(state.DepositToAccountRef)) issues.push('Choose the account to deposit to.');
  state.lines.forEach((l, i) => {
    if (isBlankDepositLine(l) || l.paymentTxnID) return;
    if (!refOut(l.AccountRef)) issues.push(`Line ${i + 1}: choose the "from" account.`);
    if (l.Amount.trim() && parseDec(l.Amount) === null)
      issues.push(`Line ${i + 1}: amount is not a number.`);
  });
  const anything =
    state.payments.some((p) => p.selected) || state.lines.some((l) => !isBlankDepositLine(l));
  if (!anything) issues.push('Select a payment or add a deposit line.');
  if (anything && depositTotal(state) <= ZERO) issues.push('The deposit total must be above zero.');
  return issues;
}

function manualLine(l: DepositLine): Json {
  const out: Json = {};
  const ent = refOut(l.EntityRef);
  if (ent) out.EntityRef = ent;
  out.AccountRef = refOut(l.AccountRef);
  if (l.Memo.trim()) out.Memo = l.Memo.trim();
  if (l.CheckNumber.trim()) out.CheckNumber = l.CheckNumber.trim();
  const pm = refOut(l.PaymentMethodRef);
  if (pm) out.PaymentMethodRef = pm;
  const cls = refOut(l.ClassRef);
  if (cls) out.ClassRef = cls;
  const amt = parseDec(l.Amount);
  if (amt !== null) out.Amount = fmtAmount(amt);
  return out;
}

export class DepositError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join(' '));
    this.name = 'DepositError';
  }
}

export function depositAddBody(state: DepositState): Json {
  const issues = depositIssues(state);
  if (issues.length) throw new DepositError(issues);
  const out: Json = {};
  if (state.TxnDate) out.TxnDate = state.TxnDate;
  out.DepositToAccountRef = refOut(state.DepositToAccountRef);
  if (state.Memo.trim()) out.Memo = state.Memo.trim();
  out.DepositLineAdd = [
    ...state.payments.filter((p) => p.selected).map((p) => ({ PaymentTxnID: p.TxnID })),
    ...state.lines.filter((l) => !isBlankDepositLine(l)).map(manualLine),
  ];
  return out;
}

/**
 * DepositMod: existing payment lines are kept by TxnLineID alone; manual
 * lines are sent in full; newly selected payments are added with TxnLineID -1.
 */
export function depositModBody(state: DepositState): Json {
  if (!state.TxnID || !state.EditSequence) throw new Error('TxnID and EditSequence are required.');
  const issues = depositIssues(state);
  if (issues.length) throw new DepositError(issues);
  const out: Json = { TxnID: state.TxnID, EditSequence: state.EditSequence };
  if (state.TxnDate) out.TxnDate = state.TxnDate;
  out.DepositToAccountRef = refOut(state.DepositToAccountRef);
  if (state.Memo.trim()) out.Memo = state.Memo.trim();
  out.DepositLineMod = [
    ...state.payments
      .filter((p) => p.selected)
      .map((p) => ({ TxnLineID: '-1', PaymentTxnID: p.TxnID })),
    ...state.lines
      .filter((l) => !isBlankDepositLine(l))
      .map((l) =>
        l.paymentTxnID && l.TxnLineID
          ? { TxnLineID: l.TxnLineID }
          : { TxnLineID: l.TxnLineID || '-1', ...manualLine(l) },
      ),
  ];
  return out;
}

function arr(v: unknown): Json[] {
  if (Array.isArray(v)) return v as Json[];
  if (v && typeof v === 'object') return [v as Json];
  return [];
}

export function depositFromRet(ret: Json): DepositState {
  return {
    TxnID: s(ret.TxnID) || undefined,
    EditSequence: s(ret.EditSequence) || undefined,
    TxnDate: s(ret.TxnDate),
    DepositToAccountRef: refIn(ret.DepositToAccountRef),
    Memo: s(ret.Memo),
    payments: [],
    lines: arr(ret.DepositLineRet).map((r) => ({
      ...blankDepositLine(),
      TxnLineID: s(r.TxnLineID) || undefined,
      paymentTxnID: s(r.TxnID) || undefined,
      EntityRef: refIn(r.EntityRef),
      AccountRef: refIn(r.AccountRef),
      Memo: s(r.Memo),
      CheckNumber: s(r.CheckNumber),
      PaymentMethodRef: refIn(r.PaymentMethodRef),
      ClassRef: refIn(r.ClassRef),
      Amount: s(r.Amount),
    })),
  };
}
