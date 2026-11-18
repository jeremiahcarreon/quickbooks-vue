/** Display formatting. Values stay as qbXML strings everywhere else. */

/** `1234.5` -> `1,234.50`. Keeps exact decimals of the string; null for empty. */
export function formatMoney(v: unknown, minDecimals = 2): string {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return s;
  const sign = m[1] === '-' ? '-' : '';
  const int = (m[2] || '0').replace(/^0+(?=\d)/, '');
  let frac = (m[3] ?? '').replace(/0+$/, '');
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, '0');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${frac ? `.${frac}` : ''}`;
}

/** `2026-01-15` -> locale date; datetimes keep their time. */
export function formatDate(v: unknown): string {
  if (!v) return '';
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

export function formatBool(v: unknown): string {
  if (v === true || v === 'true') return 'Yes';
  if (v === false || v === 'false') return 'No';
  return '';
}

/** Text of a parsed simple value (`{ '#text': 'x', '@useMacro': ... }` -> 'x'). */
export function textOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ('#text' in o) return String(o['#text'] ?? '');
    if ('FullName' in o) return String(o.FullName ?? '');
    if ('ListID' in o) return String(o.ListID ?? '');
    return '';
  }
  return String(v);
}

/** Relative "2 min ago" for recent timestamps. */
export function timeAgo(v: string | null | undefined, now = Date.now()): string {
  if (!v) return '';
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
