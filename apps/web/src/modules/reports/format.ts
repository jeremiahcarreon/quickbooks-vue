import type { CellValue, ColumnType, ReportResult } from './types';

const NUMERIC: ReadonlySet<ColumnType> = new Set([
  'amount',
  'price',
  'quantity',
  'percent',
  'number',
]);

export const isNumericColumn = (t: ColumnType): boolean => NUMERIC.has(t);

const amountFmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fiveFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 5 });
const pctFmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 2,
});

/** Display text for a cell. Negative amounts use a leading minus, as QuickBooks does. */
export function formatCell(v: CellValue | undefined, type: ColumnType): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    switch (type) {
      case 'amount':
        return amountFmt.format(v);
      case 'percent':
        return `${pctFmt.format(v)}%`;
      case 'number':
        return String(v);
      default:
        return fiveFmt.format(v);
    }
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (type === 'datetime') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
  }
  return v;
}

/** Prefix text a spreadsheet would treat as a formula. */
function defuse(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvCell(v: CellValue | undefined, indent = 0): string {
  if (v === null || v === undefined) return '';
  const s = '  '.repeat(indent) + (typeof v === 'string' ? defuse(v) : String(v));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV (RFC 4180) of the loaded report; numbers stay unformatted for spreadsheets. */
export function toCsv(result: ReportResult): string {
  const lines = [csvCell(result.meta.title)];
  if (result.meta.subtitle) lines.push(csvCell(result.meta.subtitle));
  lines.push('');
  lines.push(result.columns.map((c) => csvCell(c.title)).join(','));
  for (const row of result.rows) {
    lines.push(
      result.columns
        .map((c, i) => {
          const v = row.cells[c.key];
          if (i > 0) return csvCell(v);
          return csvCell(v ?? (row.kind === 'data' ? null : (row.label ?? null)), row.indent);
        })
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

export function csvFileName(result: ReportResult): string {
  const base = result.meta.title.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'report';
  return `${base}.csv`;
}

/** Trigger a download of the report as CSV. */
export function downloadCsv(result: ReportResult): void {
  const blob = new Blob(['﻿', toCsv(result)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = csvFileName(result);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
