import type { CellValue, ReportResult } from './types.js';

/** Prefix text that a spreadsheet would run as a formula. */
function defuse(v: CellValue): CellValue {
  return typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function cell(v: CellValue | undefined, indent = 0): string {
  if (v === null || v === undefined) return '';
  const s = '  '.repeat(indent) + String(defuse(v));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * RFC 4180 CSV of a report: title lines, a header row, then every row with
 * the first column indented by two spaces per level.
 */
export function reportToCsv(result: ReportResult, opts: { header?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.header !== false) {
    lines.push(cell(result.meta.title));
    if (result.meta.subtitle) lines.push(cell(result.meta.subtitle));
    lines.push('');
  }
  const cols = result.columns;
  lines.push(cols.map((c) => cell(c.title)).join(','));
  for (const row of result.rows) {
    const values = cols.map((c, i) => {
      const v = row.cells[c.key];
      if (i > 0) return cell(v);
      return cell(v ?? (row.kind === 'data' ? null : (row.label ?? null)), row.indent);
    });
    lines.push(values.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
