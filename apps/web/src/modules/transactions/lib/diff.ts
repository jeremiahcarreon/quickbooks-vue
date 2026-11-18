/** Field-level differences for the conflict view. */
import { refLabel } from './refs';
import type { HeaderField } from './types';

export interface DiffRow {
  field: string;
  label: string;
  mine: string;
  theirs: string;
}

/** Plain-text rendering of a form or Ret value for comparison. */
export function show(kind: HeaderField['kind'], v: unknown): string {
  const x = Array.isArray(v) ? v[0] : v;
  if (x === undefined || x === null) return '';
  if (kind === 'ref') return refLabel(x);
  if (kind === 'bool')
    return x === true || x === 'true' ? 'Yes' : x === false || x === 'false' ? 'No' : '';
  if (kind === 'address' && typeof x === 'object') {
    const a = x as Record<string, unknown>;
    return ['Addr1', 'Addr2', 'Addr3', 'Addr4', 'Addr5', 'City', 'State', 'PostalCode', 'Country']
      .map((k) => (typeof a[k] === 'string' ? (a[k] as string).trim() : ''))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof x === 'string' || typeof x === 'number') return String(x).trim();
  return '';
}

/**
 * Header fields where the user's value differs from what QuickBooks has now.
 * Numeric fields compare by value ("10" equals "10.00").
 */
export function diffFields(
  fields: readonly HeaderField[],
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const f of fields) {
    const a = show(f.kind, mine[f.name]);
    const b = show(f.kind, theirs[f.name]);
    const numeric = f.kind === 'amount' || f.kind === 'price' || f.kind === 'qty';
    const same =
      numeric && a && b ? Number(a.replace(/,/g, '')) === Number(b.replace(/,/g, '')) : a === b;
    if (!same) rows.push({ field: f.name, label: f.label, mine: a, theirs: b });
  }
  return rows;
}
