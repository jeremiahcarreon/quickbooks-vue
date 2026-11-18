import type { NewQbObject } from './schema.js';

/**
 * The subset of @qbv/qbxml's EntityDef that row extraction needs. Kept
 * structural so this package does not need the generated catalog at build time.
 */
export interface EntityLike {
  name: string;
  category?: 'list' | 'txn' | 'other';
  idField?: 'ListID' | 'TxnID' | null;
}

export type Ret = Record<string, unknown>;

/** Per-entity overrides for column extraction. */
export interface ExtractOverrides {
  qbId?: (ret: Ret) => string | null | undefined;
  name?: (ret: Ret) => string | null | undefined;
  amount?: (ret: Ret) => string | null | undefined;
  entityRefId?: (ret: Ret) => string | null | undefined;
}

/** Ref elements, in priority order, that identify the counterparty of a transaction. */
export const ENTITY_REF_FIELDS = [
  'CustomerRef',
  'VendorRef',
  'EntityRef',
  'PayeeEntityRef',
  'EmployeeRef',
] as const;

/** Amount elements, in priority order. Invoice-like rets fall back to Subtotal + SalesTaxTotal. */
export const AMOUNT_FIELDS = [
  'TotalAmount',
  'Amount',
  'AmountDue',
  'DepositTotal',
  'CreditAmount',
  'TotalBalance',
  'Balance',
] as const;

const DECIMAL_RE = /^[+-]?\d+(\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** First element when the parser produced an array, else the value itself. */
function one(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

function str(v: unknown): string | null {
  const x = one(v);
  if (x === undefined || x === null) return null;
  if (typeof x === 'string') return x;
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  return null;
}

function refField(ret: Ret, refName: string, field: 'ListID' | 'FullName'): string | null {
  const ref = one(ret[refName]);
  if (!ref || typeof ref !== 'object') return null;
  return str((ref as Record<string, unknown>)[field]);
}

function decimal(v: unknown): string | null {
  const s = str(v)?.trim();
  return s && DECIMAL_RE.test(s) ? s : null;
}

/** Exact decimal addition on strings (no float rounding). */
export function addDecimals(a: string, b: string): string {
  const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0);
  const toInt = (s: string): bigint => {
    const neg = s.startsWith('-');
    const [i, f = ''] = s.replace(/^[+-]/, '').split('.');
    const n = BigInt((i ?? '0') + f.padEnd(scale, '0'));
    return neg ? -n : n;
  };
  const sum = toInt(a) + toInt(b);
  const neg = sum < 0n;
  const digits = (neg ? -sum : sum).toString().padStart(scale + 1, '0');
  const out = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return neg ? `-${out}` : out;
}

export function extractQbId(entity: EntityLike, ret: Ret): string | null {
  if (entity.idField) return str(ret[entity.idField]);
  const id = str(ret.ListID) ?? str(ret.TxnID);
  if (id) return id;
  // Entities without an ID (Company, Preferences, Host, ...): key by name, or
  // treat as a singleton when explicitly declared idField: null.
  return str(ret.Name) ?? str(ret.FullName) ?? (entity.idField === null ? 'singleton' : null);
}

export function extractName(ret: Ret): string | null {
  const own = str(ret.FullName) ?? str(ret.Name) ?? str(ret.CompanyName);
  if (own) return own;
  for (const f of ENTITY_REF_FIELDS) {
    const n = refField(ret, f, 'FullName');
    if (n) return n;
  }
  return null;
}

export function extractEntityRefId(ret: Ret): string | null {
  for (const f of ENTITY_REF_FIELDS) {
    const id = refField(ret, f, 'ListID');
    if (id) return id;
  }
  return null;
}

export function extractAmount(ret: Ret): string | null {
  for (const f of AMOUNT_FIELDS.slice(0, 5)) {
    const v = decimal(ret[f]);
    if (v !== null) return v;
  }
  const subtotal = decimal(ret.Subtotal);
  if (subtotal !== null) {
    const tax = decimal(ret.SalesTaxTotal);
    return tax !== null ? addDecimals(subtotal, tax) : subtotal;
  }
  for (const f of AMOUNT_FIELDS.slice(5)) {
    const v = decimal(ret[f]);
    if (v !== null) return v;
  }
  return null;
}

function bool(v: unknown): boolean | null {
  const s = str(v);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

function date(v: unknown): string | null {
  const s = str(v);
  return s && DATE_RE.test(s) ? s : null;
}

function timestamp(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return Number.isNaN(Date.parse(s)) ? null : s;
}

export class RowExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RowExtractionError';
  }
}

/**
 * Map one parsed Ret (element-named object, leaf values as strings) to a
 * qb_object row. `data` keeps the full Ret; the other columns are extracted
 * for indexing, sorting and search.
 */
export function toRow(
  entity: EntityLike,
  ret: Ret,
  opts: { syncedAt?: Date; overrides?: ExtractOverrides } = {},
): NewQbObject {
  const o = opts.overrides ?? {};
  const qbId = o.qbId ? o.qbId(ret) : extractQbId(entity, ret);
  if (!qbId) {
    throw new RowExtractionError(
      `${entity.name}: Ret has no ${entity.idField ?? 'ListID/TxnID'}; cannot store it`,
    );
  }
  return {
    type: entity.name,
    qb_id: qbId,
    edit_sequence: str(ret.EditSequence),
    name: (o.name ? o.name(ret) : extractName(ret)) ?? null,
    ref_number: str(ret.RefNumber),
    txn_date: date(ret.TxnDate),
    entity_ref_id: (o.entityRefId ? o.entityRefId(ret) : extractEntityRefId(ret)) ?? null,
    amount: (o.amount ? o.amount(ret) : extractAmount(ret)) ?? null,
    is_active: bool(ret.IsActive),
    time_created: timestamp(ret.TimeCreated),
    time_modified: timestamp(ret.TimeModified),
    data: ret,
    synced_at: opts.syncedAt ?? new Date(),
    deleted_at: null,
  };
}
