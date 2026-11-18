import { sql, type RawBuilder } from 'kysely';
import { addDecimals, type Db } from '@qbv/db';
import { DATE_MACROS, resolveDateMacro, type DateMacro, type DateRange } from '../dates.js';
import type {
  CellValue,
  ParamDef,
  ReportColumn,
  ReportDefinitionInfo,
  ReportParams,
  ReportResult,
  ReportRow,
} from '../types.js';

export interface SqlRunContext {
  /** Local date the report runs on (YYYY-MM-DD). */
  today: string;
}

export type SqlReportOutput = Omit<ReportResult, 'meta'> & { subtitle?: string; notes?: string[] };

export interface SqlReportDefinition extends ReportDefinitionInfo {
  source: 'sql';
  run(db: Db, params: ReportParams, ctx: SqlRunContext): Promise<SqlReportOutput>;
}

// ---------------------------------------------------------------- params

export const periodParams = (defaultMacro: DateMacro): ParamDef[] => [
  { name: 'from', label: 'From', type: 'date', group: 'period' },
  { name: 'to', label: 'To', type: 'date', group: 'period' },
  {
    name: 'dateMacro',
    label: 'Dates',
    type: 'enum',
    options: [...DATE_MACROS],
    default: defaultMacro,
    group: 'period',
    help: 'Used when From/To are not given',
  },
];

export const asOfParam: ParamDef = {
  name: 'asOf',
  label: 'As of',
  type: 'date',
  group: 'period',
  help: 'Defaults to today',
};

export const nameFilterParam = (label: string): ParamDef => ({
  name: 'name',
  label,
  type: 'string',
  group: 'filter',
  help: 'Contains (case-insensitive)',
});

/** from/to take precedence; otherwise the macro (or the default) decides. */
export function resolvePeriod(params: ReportParams, today: string, fallback: DateMacro): DateRange {
  const from = typeof params.from === 'string' ? params.from : undefined;
  const to = typeof params.to === 'string' ? params.to : undefined;
  if (from || to) return { from, to };
  const macro = (typeof params.dateMacro === 'string' ? params.dateMacro : fallback) as DateMacro;
  return resolveDateMacro(macro, today);
}

export function periodSubtitle(r: DateRange): string {
  if (r.from && r.to) return r.from === r.to ? r.to : `${r.from} through ${r.to}`;
  if (r.from) return `From ${r.from}`;
  if (r.to) return `Through ${r.to}`;
  return 'All dates';
}

// ---------------------------------------------------------------- SQL fragments

const IDENT_RE = /^[A-Za-z][A-Za-z0-9]*$/;

function path(field: string, root = 'data'): string {
  const segs = field.split('.');
  for (const s of segs) if (!IDENT_RE.test(s)) throw new Error(`Bad field name ${field}`);
  if (segs.length === 1) return `${root}->>'${segs[0]}'`;
  return `${root}#>>'{${segs.join(',')}}'`;
}

/** Text value of a (constant) qbXML field path, e.g. `TermsRef.FullName`. */
export function txt(field: string, root = 'data'): RawBuilder<string | null> {
  return sql.raw<string | null>(path(field, root));
}

/** Numeric value of a (constant) field path; null when missing or not a number. */
export function num(field: string, root = 'data'): RawBuilder<string | null> {
  const p = path(field, root);
  return sql.raw<string | null>(
    `(case when (${p}) ~ '^[+-]?[0-9]+(\\.[0-9]+)?$' then (${p})::numeric end)`,
  );
}

/** Date value of a (constant) field path; null when missing or malformed. */
export function dt(field: string, root = 'data'): RawBuilder<string | null> {
  const p = path(field, root);
  return sql.raw<string | null>(
    `(case when (${p}) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (${p})::date end)`,
  );
}

export const notPending = sql.raw<boolean>(`coalesce(data->>'IsPending', 'false') <> 'true'`);

/** `and name ilike %x%` when a name filter is given. */
export function nameFilter(params: ReportParams, column = 'name'): RawBuilder<unknown> {
  const n = typeof params.name === 'string' ? params.name : '';
  if (!n) return sql``;
  const escaped = n.replace(/[\\%_]/g, (c) => `\\${c}`);
  return sql`and ${sql.ref(column)} ilike ${`%${escaped}%`}`;
}

export function dateRangeFilter(r: DateRange, column = 'txn_date'): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = [];
  if (r.from) parts.push(sql`and ${sql.ref(column)} >= ${r.from}::date`);
  if (r.to) parts.push(sql`and ${sql.ref(column)} <= ${r.to}::date`);
  return parts.length ? sql.join(parts, sql` `) : sql``;
}

// ---------------------------------------------------------------- decimals

/** Exact decimal strings (from Postgres numeric). */
export const Dec = {
  zero: '0',
  add(a: string | null | undefined, b: string | null | undefined): string {
    return addDecimals(a ?? '0', b ?? '0');
  },
  sum(values: (string | null | undefined)[]): string {
    return values.reduce<string>((acc, v) => Dec.add(acc, v), '0');
  },
  /** Rounded to cents for display. */
  toNumber(v: string | null | undefined): number {
    if (v === null || v === undefined) return 0;
    const n = Number(v);
    return Math.round(n * 100) / 100 || 0;
  },
  isZero(v: string | null | undefined): boolean {
    return !v || Number(v) === 0;
  },
};

export function pct(part: string, whole: string): number | null {
  const w = Number(whole);
  if (!w) return null;
  return Math.round((Number(part) / w) * 10000) / 100;
}

// ---------------------------------------------------------------- output

export class ReportBuilder {
  readonly rows: ReportRow[] = [];
  totals: Record<string, CellValue> | null = null;
  constructor(readonly columns: ReportColumn[]) {}

  get labelKey(): string {
    return this.columns[0]!.key;
  }

  text(label: string, indent = 0): void {
    this.rows.push({ kind: 'text', indent, label, cells: { [this.labelKey]: label } });
  }

  data(
    cells: Record<string, CellValue>,
    opts: { indent?: number; ref?: { type: string; id: string }; label?: string } = {},
  ): void {
    const row: ReportRow = { kind: 'data', indent: opts.indent ?? 0, cells };
    const label =
      opts.label ??
      (typeof cells[this.labelKey] === 'string' ? (cells[this.labelKey] as string) : undefined);
    if (label !== undefined) row.label = label;
    if (opts.ref) row.ref = opts.ref;
    this.rows.push(row);
  }

  subtotal(label: string, cells: Record<string, CellValue>, indent = 0): void {
    this.rows.push({
      kind: 'subtotal',
      indent,
      label,
      cells: { ...cells, [this.labelKey]: label },
    });
  }

  total(label: string, cells: Record<string, CellValue>): void {
    const all = { ...cells, [this.labelKey]: label };
    this.rows.push({ kind: 'total', indent: 0, label, cells: all });
    this.totals = all;
  }

  output(extra: { subtitle?: string; notes?: string[] } = {}): SqlReportOutput {
    return { columns: this.columns, rows: this.rows, totals: this.totals, ...extra };
  }
}

export async function rowsOf<T>(db: Db, q: RawBuilder<T>): Promise<T[]> {
  const r = await q.execute(db);
  return r.rows;
}

/** Group rows by a key, keeping first-seen order. */
export function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}
