/**
 * Exact decimal arithmetic for display totals.
 *
 * Values are bigints scaled by 10^10, enough to hold a QUANTYPE (5 places)
 * times a PRICETYPE (5 places) without loss. Rounding is half away from zero,
 * which is what QuickBooks does for amounts. These numbers are for display
 * only: QuickBooks computes the authoritative amounts.
 */

export type Dec = bigint;

export const SCALE = 10;
const ONE = 10n ** BigInt(SCALE);

export const ZERO: Dec = 0n;

const DEC_RE = /^([+-])?(\d*)(?:\.(\d*))?$/;

/** Parse "1,234.50", "-3", ".5", "(12.00)" etc. Empty or invalid input gives null. */
export function parseDec(input: unknown): Dec | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'bigint') return input * ONE;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return parseDec(input.toFixed(SCALE));
  }
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/[,\s$]/g, '');
  if (!s) return null;
  let negate = false;
  if (/^\(.*\)$/.test(s)) {
    negate = true;
    s = s.slice(1, -1);
  }
  const m = DEC_RE.exec(s);
  if (!m) return null;
  const [, sign, intPart = '', fracPart = ''] = m;
  if (!intPart && !fracPart) return null;
  const frac = fracPart.slice(0, SCALE).padEnd(SCALE, '0');
  let v = BigInt(intPart || '0') * ONE + BigInt(frac || '0');
  // Round on the first dropped digit.
  if (fracPart.length > SCALE && Number(fracPart[SCALE]) >= 5) v += 1n;
  if (sign === '-') v = -v;
  return negate ? -v : v;
}

/** parseDec with 0 for empty input. */
export function dec(input: unknown): Dec {
  return parseDec(input) ?? ZERO;
}

function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('Division by zero');
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n;
  return neg ? -q : q;
}

export function add(...xs: Dec[]): Dec {
  return xs.reduce((a, b) => a + b, ZERO);
}

export function sub(a: Dec, b: Dec): Dec {
  return a - b;
}

export function mul(a: Dec, b: Dec): Dec {
  return divRound(a * b, ONE);
}

/** a / b rounded to `places`; null when b is zero. */
export function div(a: Dec, b: Dec, places = SCALE): Dec | null {
  if (b === 0n) return null;
  return round(divRound(a * ONE, b), places);
}

/** Round to `places` decimal places (half away from zero). */
export function round(a: Dec, places = 2): Dec {
  if (places >= SCALE) return a;
  const f = 10n ** BigInt(SCALE - places);
  return divRound(a, f) * f;
}

export function neg(a: Dec): Dec {
  return -a;
}

export function abs(a: Dec): Dec {
  return a < 0n ? -a : a;
}

export function min(a: Dec, b: Dec): Dec {
  return a < b ? a : b;
}

export function max(a: Dec, b: Dec): Dec {
  return a > b ? a : b;
}

export function isZero(a: Dec): boolean {
  return a === 0n;
}

export function sum<T>(items: readonly T[], pick: (item: T) => Dec): Dec {
  return items.reduce((acc, it) => acc + pick(it), ZERO);
}

/**
 * Format with exactly `minPlaces`..`maxPlaces` decimals (trailing zeros past
 * minPlaces are trimmed). Rounds to maxPlaces first.
 */
export function fmt(a: Dec, maxPlaces = 2, minPlaces = maxPlaces): string {
  const r = round(a, maxPlaces);
  const negative = r < 0n;
  const v = negative ? -r : r;
  const int = v / ONE;
  let frac = (v % ONE).toString().padStart(SCALE, '0').slice(0, maxPlaces);
  while (frac.length > minPlaces && frac.endsWith('0')) frac = frac.slice(0, -1);
  const body = frac ? `${int}.${frac}` : `${int}`;
  return negative && (int !== 0n || /[1-9]/.test(frac)) ? `-${body}` : body;
}

/** AMTTYPE wire format: two decimals. */
export function fmtAmount(a: Dec): string {
  return fmt(a, 2, 2);
}

/** PRICETYPE / QUANTYPE / PERCENTTYPE wire format: up to five decimals, no trailing zeros. */
export function fmtPrice(a: Dec): string {
  return fmt(a, 5, 0);
}

/** Display with thousands separators: 1,234.50 (negative as -1,234.50). */
export function fmtMoney(a: Dec): string {
  const s = fmtAmount(a);
  const negative = s.startsWith('-');
  const [i = '0', f = '00'] = (negative ? s.slice(1) : s).split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${f}`;
}

/** Normalise user input to an AMTTYPE string, or '' when empty/invalid. */
export function normAmount(input: unknown): string {
  const d = parseDec(input);
  return d === null ? '' : fmtAmount(d);
}

/** Normalise user input to a PRICETYPE/QUANTYPE string, or '' when empty/invalid. */
export function normPrice(input: unknown): string {
  const d = parseDec(input);
  return d === null ? '' : fmtPrice(d);
}

export function toNumber(a: Dec): number {
  return Number(fmt(a, SCALE, 0));
}
