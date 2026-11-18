// Typed views over qbXML leaf strings, and formatting of JS values into the
// lexical forms the XSD base types accept.

/** Thrown when a JS value cannot be represented in a qbXML base type. */
export class QbxmlValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QbxmlValueError';
  }
}

type Maybe = string | number | null | undefined;

/** Parse a qbXML numeric string (AMTTYPE, PRICETYPE, QUANTYPE, PERCENTTYPE, INTTYPE, FLOATTYPE). */
export function toNumber(v: Maybe): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const s = v.trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse BOOLTYPE ('true' / 'false' / '1' / '0'). */
export function toBool(v: string | boolean | null | undefined): boolean | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return undefined;
}

/** Parse DATETYPE (YYYY-MM-DD) into a Date at UTC midnight. */
export function toDate(v: string | null | undefined): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v.trim());
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Parse DATETIMETYPE (e.g. 2024-03-01T10:20:30-08:00). Values without an
 * offset are interpreted in the process's local time zone, as QuickBooks does.
 */
export function toDateTime(v: string | null | undefined): Date | undefined {
  if (!v) return undefined;
  const m =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2})(?::(\d{1,2})(?::(\d{1,2})(?:([+-])(\d{1,2}):(\d{1,2}))?)?)?)?$/.exec(
      v.trim(),
    );
  if (!m) return undefined;
  const [, y, mo, d, h = '0', mi = '0', s = '0', sign, oh, om] = m;
  let ms: number;
  if (sign) {
    const off = (Number(oh) * 60 + Number(om)) * (sign === '-' ? -1 : 1);
    ms =
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) -
      off * 60_000;
  } else {
    ms = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
  }
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

// ---------------------------------------------------------------------------
// Formatting

/** Exact decimal rounding (half away from zero) on the decimal string form. */
function roundDecimal(input: number | string, places: number): string {
  let s = typeof input === 'number' ? numberToPlain(input) : input.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s))
    throw new QbxmlValueError(`"${String(input)}" is not a decimal number`);
  let neg = false;
  if (s[0] === '+' || s[0] === '-') {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  let [int = '0', frac = ''] = s.split('.');
  if (int === '') int = '0';
  if (frac.length > places) {
    const roundUp = Number(frac[places]) >= 5;
    frac = frac.slice(0, places);
    if (roundUp) {
      const digits = (int + frac).split('').map(Number);
      let i = digits.length - 1;
      while (i >= 0) {
        if (digits[i] === 9) {
          digits[i] = 0;
          i--;
        } else {
          digits[i] = (digits[i] ?? 0) + 1;
          break;
        }
      }
      if (i < 0) digits.unshift(1);
      const all = digits.join('');
      int = all.slice(0, all.length - places);
      frac = all.slice(all.length - places);
    }
  }
  int = int.replace(/^0+(?=\d)/, '');
  const out = places > 0 ? `${int}.${frac.padEnd(places, '0')}` : int;
  const isZero = /^[0.]*$/.test(out);
  return neg && !isZero ? `-${out}` : out;
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new QbxmlValueError(`${n} is not a finite number`);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  // expand exponent notation
  return n.toFixed(20).replace(/\.?0+$/, '');
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** AMTTYPE: up to 13 integer digits, exactly two decimals (e.g. 1234.50). */
export function formatAmount(v: number | string): string {
  const s = roundDecimal(v, 2);
  if (s.replace(/^-/, '').split('.')[0]!.length > 13)
    throw new QbxmlValueError(`Amount ${String(v)} exceeds AMTTYPE range`);
  return s;
}

function format5(v: number | string, label: string): string {
  const s = trimZeros(roundDecimal(v, 5));
  if (s.replace(/^-/, '').split('.')[0]!.length > 10)
    throw new QbxmlValueError(`${label} ${String(v)} exceeds range`);
  return s;
}

/** PRICETYPE: up to 10 integer digits and 5 decimals. */
export const formatPrice = (v: number | string): string => format5(v, 'Price');
/** QUANTYPE: up to 10 integer digits and 5 decimals. */
export const formatQuantity = (v: number | string): string => format5(v, 'Quantity');
/** PERCENTTYPE: up to 10 integer digits and 5 decimals (15 means 15%). */
export const formatPercent = (v: number | string): string => format5(v, 'Percent');

/** INTTYPE */
export function formatInt(v: number | string): string {
  const s = typeof v === 'number' ? numberToPlain(v) : v.trim();
  if (!/^[+-]?\d+$/.test(s)) throw new QbxmlValueError(`"${String(v)}" is not an integer`);
  return s;
}

/** BOOLTYPE */
export function formatBool(v: boolean | string): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const b = toBool(v);
  if (b === undefined) throw new QbxmlValueError(`"${v}" is not a boolean`);
  return b ? 'true' : 'false';
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** DATETYPE (YYYY-MM-DD). Date objects are formatted using their UTC date, matching toDate(). */
export function formatDate(v: Date | string): string {
  if (typeof v === 'string') return v;
  if (Number.isNaN(v.getTime())) throw new QbxmlValueError('Invalid Date');
  return `${pad(v.getUTCFullYear(), 4)}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
}

/**
 * DATETIMETYPE (YYYY-MM-DDThh:mm:ss±hh:mm). Date objects are written in the
 * process's local time zone with its offset (or UTC with `{ utc: true }`).
 */
export function formatDateTime(v: Date | string, opts: { utc?: boolean } = {}): string {
  if (typeof v === 'string') return v;
  if (Number.isNaN(v.getTime())) throw new QbxmlValueError('Invalid Date');
  if (opts.utc) {
    return (
      `${pad(v.getUTCFullYear(), 4)}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}` +
      `T${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}+00:00`
    );
  }
  const off = -v.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return (
    `${pad(v.getFullYear(), 4)}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` +
    `T${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
  );
}

export type QbScalar = string | number | boolean | Date | bigint;

/** Format a JS scalar for a field of the given base type. Strings pass through unchanged. */
export function formatValue(type: string, v: QbScalar): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  switch (type) {
    case 'AMTTYPE':
      if (typeof v === 'number') return formatAmount(v);
      break;
    case 'PRICETYPE':
    case 'QUANTYPE':
    case 'PERCENTTYPE':
      if (typeof v === 'number') return format5(v, type);
      break;
    case 'INTTYPE':
      if (typeof v === 'number') return formatInt(v);
      break;
    case 'FLOATTYPE':
      if (typeof v === 'number') return numberToPlain(v);
      break;
    case 'BOOLTYPE':
      if (typeof v === 'boolean') return formatBool(v);
      break;
    case 'DATETYPE':
      if (v instanceof Date) return formatDate(v);
      break;
    case 'DATETIMETYPE':
      if (v instanceof Date) return formatDateTime(v);
      break;
    default:
      if (typeof v === 'number') return numberToPlain(v);
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (v instanceof Date) return formatDateTime(v);
  }
  throw new QbxmlValueError(
    `Cannot write ${v instanceof Date ? 'Date' : typeof v} value into a ${type} field`,
  );
}

/** Display money: "1,234.50" style with a fixed number of decimals, from a qbXML string. */
export function formatMoney(v: Maybe, opts: { currency?: string; locale?: string } = {}): string {
  const n = toNumber(v);
  if (n === undefined) return '';
  return new Intl.NumberFormat(opts.locale ?? 'en-US', {
    style: opts.currency ? 'currency' : 'decimal',
    currency: opts.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}
