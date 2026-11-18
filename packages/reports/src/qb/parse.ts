import { parseResponse, isOk } from '@qbv/qbxml';
import { ReportError } from '../params.js';
import type {
  CellValue,
  ColumnType,
  ReportColumn,
  ReportMeta,
  ReportResult,
  ReportRow,
  RowKind,
} from '../types.js';

type Obj = Record<string, unknown>;

const DATA_TYPES: Record<string, ColumnType> = {
  AMTTYPE: 'amount',
  PRICETYPE: 'price',
  QUANTYPE: 'quantity',
  PERCENTTYPE: 'percent',
  INTTYPE: 'number',
  BOOLTYPE: 'boolean',
  DATETYPE: 'date',
  DATETIMETYPE: 'datetime',
};

const NUMERIC: ReadonlySet<ColumnType> = new Set([
  'amount',
  'price',
  'quantity',
  'percent',
  'number',
]);

const ROW_ELEMENTS: Record<string, RowKind> = {
  DataRow: 'data',
  TextRow: 'text',
  SubtotalRow: 'subtotal',
  TotalRow: 'total',
};

function arr(v: unknown): Obj[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x): x is Obj => !!x && typeof x === 'object');
}

function attr(o: Obj | undefined, name: string): string | undefined {
  const v = o?.[`@${name}`];
  return typeof v === 'string' ? v : undefined;
}

function text(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as Obj)['#text'] === 'string') {
    return (v as Obj)['#text'] as string;
  }
  return undefined;
}

/** QuickBooks numbers may carry thousands separators, a trailing %, or parentheses for negatives. */
export function parseQbNumber(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/,/g, '').replace(/%$/, '');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

function cellValue(raw: string | undefined, type: ColumnType): CellValue {
  if (raw === undefined) return null;
  if (NUMERIC.has(type)) {
    const n = parseQbNumber(raw);
    return n === null ? raw : n;
  }
  if (type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
  return raw;
}

export const colKey = (colID: string): string => `c${colID}`;

/** Parse one ReportRet object (as produced by parseResponse) into the normalized shape. */
export function normalizeReportRet(
  ret: Obj,
  meta: Omit<ReportMeta, 'rowCount' | 'title' | 'subtitle' | 'basis'> & { title?: string },
): ReportResult {
  const titleRows = Number(text(ret.NumColTitleRows) ?? '1') || 1;
  const columns: ReportColumn[] = arr(ret.ColDesc).map((cd) => {
    const colID = attr(cd, 'colID') ?? '';
    const titles: string[] = Array.from({ length: titleRows }, () => '');
    for (const t of arr(cd.ColTitle)) {
      const row = Number(attr(t, 'titleRow') ?? '1');
      const v = attr(t, 'value') ?? '';
      if (row >= 1 && row <= titleRows) titles[row - 1] = v;
      else titles.push(v);
    }
    const qbType = text(cd.ColType);
    const col: ReportColumn = {
      key: colKey(colID),
      title: titles.filter(Boolean).join(' '),
      type: DATA_TYPES[attr(cd, 'dataType') ?? ''] ?? 'text',
    };
    if (titleRows > 1) col.titles = titles;
    if (qbType) col.qbType = qbType;
    return col;
  });
  const typeOf = new Map(columns.map((c) => [c.key, c.type]));
  const labelKey = columns.find((c) => c.type === 'text')?.key;

  const data = (ret.ReportData ?? {}) as Obj;
  const raw: { kind: RowKind; n: number; el: Obj; seq: number }[] = [];
  let seq = 0;
  for (const [el, kind] of Object.entries(ROW_ELEMENTS)) {
    for (const r of arr(data[el])) {
      const n = Number(attr(r, 'rowNumber'));
      raw.push({ kind, n: Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER, el: r, seq: seq++ });
    }
  }
  // The schema's repeating choice lets row kinds interleave; rowNumber restores the order.
  raw.sort((a, b) => a.n - b.n || a.seq - b.seq);

  const rows: ReportRow[] = [];
  let depth = 0;
  let totals: Record<string, CellValue> | null = null;
  for (const { kind, el } of raw) {
    const row: ReportRow = { kind, indent: 0, cells: {} };
    if (kind === 'text') {
      row.label = attr(el, 'value') ?? '';
      row.indent = depth;
      if (labelKey) row.cells[labelKey] = row.label;
      depth++;
    } else {
      for (const cd of arr(el.ColData)) {
        const key = colKey(attr(cd, 'colID') ?? '');
        row.cells[key] = cellValue(attr(cd, 'value'), typeOf.get(key) ?? 'text');
      }
      const rd = arr(el.RowData)[0];
      const rowType = attr(rd, 'rowType');
      const rowValue = attr(rd, 'value');
      if (rowType) row.rowType = rowType;
      if (rowValue !== undefined) row.rowValue = rowValue;
      const firstText = columns
        .map((c) => row.cells[c.key])
        .find((v): v is string => typeof v === 'string' && v.trim() !== '');
      const label = firstText ?? rowValue;
      if (label !== undefined) row.label = label;
      if (kind === 'subtotal') {
        depth = Math.max(0, depth - 1);
        row.indent = depth;
      } else if (kind === 'total') {
        depth = 0;
        row.indent = 0;
        totals = { ...row.cells };
      } else {
        row.indent = depth;
      }
    }
    rows.push(row);
  }

  const out: ReportMeta = {
    ...meta,
    title: text(ret.ReportTitle) ?? meta.title ?? meta.name,
    rowCount: rows.filter((r) => r.kind === 'data').length,
  };
  const subtitle = text(ret.ReportSubtitle);
  if (subtitle) out.subtitle = subtitle;
  const basis = text(ret.ReportBasis);
  if (basis) out.basis = basis;
  return { columns, rows, totals, meta: out };
}

/**
 * Parse a full qbXML response for a report request. Throws ReportError (502)
 * carrying QuickBooks' status when the request failed.
 */
export function parseQbReportResponse(
  xml: string,
  meta: Omit<ReportMeta, 'rowCount' | 'title' | 'subtitle' | 'basis'> & { title?: string },
): ReportResult {
  const rs = parseResponse(xml).find((r) => /ReportQueryRs$/.test(r.name));
  if (!rs) throw new ReportError(502, 'qb_bad_response', 'QuickBooks response has no report');
  if (!isOk(rs)) {
    throw new ReportError(502, 'qb_error', `QuickBooks: ${rs.statusMessage}`, {
      statusCode: rs.statusCode,
      statusSeverity: rs.statusSeverity,
      statusMessage: rs.statusMessage,
    });
  }
  const ret = rs.rets[0];
  if (!ret) {
    // statusCode 1 ("no data") and similar: an empty report.
    return {
      columns: [],
      rows: [],
      totals: null,
      meta: { ...meta, title: meta.title ?? meta.name, rowCount: 0, notes: [rs.statusMessage] },
    };
  }
  return normalizeReportRet(ret, meta);
}
