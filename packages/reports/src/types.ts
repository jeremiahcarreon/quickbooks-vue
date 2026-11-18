/**
 * Normalized report output shared by SQL and QuickBooks-sourced reports.
 * The web UI and integrations render both kinds the same way.
 */

/** How a column's values should be formatted and aligned. */
export type ColumnType =
  'text' | 'date' | 'datetime' | 'amount' | 'price' | 'quantity' | 'percent' | 'number' | 'boolean';

export interface ReportColumn {
  /** Key into `ReportRow.cells` and `totals`. */
  key: string;
  /** Display title (multi-row QuickBooks titles joined with a space). */
  title: string;
  /** Each title row, for reports with several column-title rows. */
  titles?: string[];
  type: ColumnType;
  /** QuickBooks ColType (`Label`, `Amount`, `Date`, ...) for QB reports. */
  qbType?: string;
}

/**
 * Row kinds, mirroring qbXML ReportData:
 * - `data`: an ordinary row
 * - `text`: a heading (group start) with only a label
 * - `subtotal`: closes a group
 * - `total`: the grand total
 */
export type RowKind = 'data' | 'text' | 'subtotal' | 'total';

export type CellValue = string | number | boolean | null;

export interface ReportRow {
  kind: RowKind;
  /** Nesting depth for display (0 = outermost). */
  indent: number;
  /** Row label (first text column or the TextRow value). */
  label?: string;
  cells: Record<string, CellValue>;
  /** QuickBooks RowData rowType (`account`, `customer`, ...) when given. */
  rowType?: string;
  /** QuickBooks RowData value (usually the full name of the row's list object). */
  rowValue?: string;
  /** Read-model link for SQL rows: open this object in the UI. */
  ref?: { type: string; id: string };
}

export interface ReportMeta {
  name: string;
  title: string;
  subtitle?: string;
  source: 'sql' | 'qb';
  /** Normalized parameters the report ran with. */
  params: Record<string, unknown>;
  generatedAt: string;
  /** Accrual / Cash basis for QB reports when reported. */
  basis?: string;
  /** For QB reports: when QuickBooks produced the data and when the cache expires. */
  fetchedAt?: string;
  expiresAt?: string;
  /** True when served from report_cache. */
  cached?: boolean;
  /** Relay command that fetched the data (QB reports). */
  commandId?: string;
  /** Number of `data` rows. */
  rowCount: number;
  /** Non-fatal notes, e.g. limits of an SQL approximation. */
  notes?: string[];
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Grand-total cells (the last TotalRow for QB reports), or null when the report has none. */
  totals: Record<string, CellValue> | null;
  meta: ReportMeta;
}

/** Parameter definition used to build forms and to validate query strings. */
export type ParamType =
  'date' | 'enum' | 'multiEnum' | 'string' | 'multiString' | 'boolean' | 'integer';

export interface ParamDef {
  name: string;
  label: string;
  type: ParamType;
  options?: string[];
  required?: boolean;
  default?: string | number | boolean | string[];
  help?: string;
  /** Form grouping hint: 'period' params get the date preset picker. */
  group?: 'period' | 'filter' | 'layout';
}

export type ReportSource = 'sql' | 'qb';

export interface ReportDefinitionInfo {
  name: string;
  title: string;
  description: string;
  category: string;
  source: ReportSource;
  params: ParamDef[];
  /** QB reports: request and report-type element value. */
  qb?: { request: string; typeField: string; typeValue: string };
}

export type ReportParams = Record<string, string | number | boolean | string[] | undefined>;
