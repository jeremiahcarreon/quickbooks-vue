/**
 * Journal entries: one grid of lines, each a debit or a credit. The entry
 * must balance (total debits = total credits, both above zero) before it can
 * be saved; QuickBooks rejects unbalanced entries anyway.
 */
import { fmtAmount, parseDec, sub, sum, ZERO, type Dec } from './decimal';
import { refIn, refOut } from './refs';
import type { RefValue } from './types';

type Json = Record<string, unknown>;

export interface JournalLine {
  key: string;
  TxnLineID?: string;
  AccountRef: RefValue | null;
  debit: string;
  credit: string;
  Memo: string;
  EntityRef: RefValue | null;
  ClassRef: RefValue | null;
  BillableStatus?: string;
}

export interface JournalState {
  TxnID?: string;
  EditSequence?: string;
  TxnDate: string;
  RefNumber: string;
  IsAdjustment?: boolean;
  /** Header memo (JournalEntryAdd.Memo; not in JournalEntryMod). */
  Memo: string;
  lines: JournalLine[];
}

export interface JournalBalance {
  debits: Dec;
  credits: Dec;
  difference: Dec;
  balanced: boolean;
  /** Line indexes with both a debit and a credit, or neither but an account. */
  invalidLines: number[];
}

function amountOf(s: string): Dec | null {
  const d = parseDec(s);
  return d === null || d === ZERO ? null : d;
}

export function isBlankJournalLine(l: JournalLine): boolean {
  return (
    !refOut(l.AccountRef) &&
    amountOf(l.debit) === null &&
    amountOf(l.credit) === null &&
    !l.Memo.trim()
  );
}

export function journalBalance(lines: readonly JournalLine[]): JournalBalance {
  const used = lines.map((l, i) => ({ l, i })).filter(({ l }) => !isBlankJournalLine(l));
  const debits = sum(used, ({ l }) => amountOf(l.debit) ?? ZERO);
  const credits = sum(used, ({ l }) => amountOf(l.credit) ?? ZERO);
  const invalidLines = used
    .filter(({ l }) => {
      const d = amountOf(l.debit);
      const c = amountOf(l.credit);
      return (
        (d !== null) === (c !== null) ||
        (d !== null && d < ZERO) ||
        (c !== null && c < ZERO) ||
        !refOut(l.AccountRef)
      );
    })
    .map(({ i }) => i);
  const difference = sub(debits, credits);
  return {
    debits,
    credits,
    difference,
    balanced: difference === ZERO && debits > ZERO && invalidLines.length === 0,
    invalidLines,
  };
}

/**
 * The amount (and side) that would balance the entry if put on a new line:
 * QuickBooks pre-fills the next line with this.
 */
export function balancingAmount(
  lines: readonly JournalLine[],
): { side: 'debit' | 'credit'; amount: string } | null {
  const { difference } = journalBalance(lines);
  if (difference === ZERO) return null;
  return difference > ZERO
    ? { side: 'credit', amount: fmtAmount(difference) }
    : { side: 'debit', amount: fmtAmount(-difference) };
}

function lineBody(l: JournalLine, amount: Dec, withId: boolean): Json {
  const out: Json = {};
  if (withId) out.TxnLineID = l.TxnLineID || '-1';
  const acct = refOut(l.AccountRef);
  if (acct) out.AccountRef = acct;
  out.Amount = fmtAmount(amount);
  if (l.Memo.trim()) out.Memo = l.Memo.trim();
  const ent = refOut(l.EntityRef);
  if (ent) out.EntityRef = ent;
  const cls = refOut(l.ClassRef);
  if (cls) out.ClassRef = cls;
  if (l.BillableStatus) out.BillableStatus = l.BillableStatus;
  return out;
}

export class UnbalancedEntryError extends Error {
  constructor(readonly balance: JournalBalance) {
    super(
      balance.invalidLines.length
        ? `Each line needs an account and either a debit or a credit (line ${balance.invalidLines.map((i) => i + 1).join(', ')}).`
        : `Debits (${fmtAmount(balance.debits)}) and credits (${fmtAmount(balance.credits)}) must be equal and above zero.`,
    );
    this.name = 'UnbalancedEntryError';
  }
}

/** JournalEntryAdd body. Throws UnbalancedEntryError when the entry does not balance. */
export function journalAddBody(state: JournalState): Json {
  const bal = journalBalance(state.lines);
  if (!bal.balanced) throw new UnbalancedEntryError(bal);
  const used = state.lines.filter((l) => !isBlankJournalLine(l));
  const out: Json = {};
  if (state.TxnDate) out.TxnDate = state.TxnDate;
  if (state.RefNumber.trim()) out.RefNumber = state.RefNumber.trim();
  if (state.Memo.trim()) out.Memo = state.Memo.trim();
  if (state.IsAdjustment !== undefined) out.IsAdjustment = state.IsAdjustment ? 'true' : 'false';
  const debits = used.filter((l) => amountOf(l.debit) !== null);
  const credits = used.filter((l) => amountOf(l.credit) !== null);
  out.JournalDebitLine = debits.map((l) => lineBody(l, amountOf(l.debit)!, false));
  out.JournalCreditLine = credits.map((l) => lineBody(l, amountOf(l.credit)!, false));
  return out;
}

/** JournalEntryMod body: every line as JournalLineMod with its JournalLineType. */
export function journalModBody(state: JournalState): Json {
  if (!state.TxnID || !state.EditSequence) throw new Error('TxnID and EditSequence are required.');
  const bal = journalBalance(state.lines);
  if (!bal.balanced) throw new UnbalancedEntryError(bal);
  const out: Json = { TxnID: state.TxnID, EditSequence: state.EditSequence };
  if (state.TxnDate) out.TxnDate = state.TxnDate;
  if (state.RefNumber.trim()) out.RefNumber = state.RefNumber.trim();
  if (state.IsAdjustment !== undefined) out.IsAdjustment = state.IsAdjustment ? 'true' : 'false';
  out.JournalLineMod = state.lines
    .filter((l) => !isBlankJournalLine(l))
    .map((l) => {
      const d = amountOf(l.debit);
      const type = d !== null ? 'Debit' : 'Credit';
      const body = lineBody(l, d ?? amountOf(l.credit)!, true);
      // JournalLineType comes right after TxnLineID in the schema.
      const { TxnLineID, ...rest } = body;
      return { TxnLineID, JournalLineType: type, ...rest };
    });
  return out;
}

let seq = 0;
export function blankJournalLine(): JournalLine {
  seq += 1;
  return {
    key: `j${seq}`,
    AccountRef: null,
    debit: '',
    credit: '',
    Memo: '',
    EntityRef: null,
    ClassRef: null,
  };
}

function arr(v: unknown): Json[] {
  if (Array.isArray(v)) return v as Json[];
  if (v && typeof v === 'object') return [v as Json];
  return [];
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');

/** Load a JournalEntryRet. Debit and credit lines are merged in their original order where TxnLineIDs allow. */
export function journalFromRet(ret: Json): JournalState {
  const toLine = (r: Json, side: 'debit' | 'credit'): JournalLine => ({
    ...blankJournalLine(),
    TxnLineID: s(r.TxnLineID) || undefined,
    AccountRef: refIn(r.AccountRef),
    debit: side === 'debit' ? s(r.Amount) : '',
    credit: side === 'credit' ? s(r.Amount) : '',
    Memo: s(r.Memo),
    EntityRef: refIn(r.EntityRef),
    ClassRef: refIn(r.ClassRef),
    BillableStatus: s(r.BillableStatus) || undefined,
  });
  const lines = [
    ...arr(ret.JournalDebitLine).map((r) => toLine(r, 'debit')),
    ...arr(ret.JournalCreditLine).map((r) => toLine(r, 'credit')),
  ];
  return {
    TxnID: s(ret.TxnID) || undefined,
    EditSequence: s(ret.EditSequence) || undefined,
    TxnDate: s(ret.TxnDate),
    RefNumber: s(ret.RefNumber),
    IsAdjustment:
      ret.IsAdjustment === 'true' ? true : ret.IsAdjustment === 'false' ? false : undefined,
    Memo: s(ret.Memo),
    lines,
  };
}
