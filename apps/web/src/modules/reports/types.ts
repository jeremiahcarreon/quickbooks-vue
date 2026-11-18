/**
 * Shapes returned by GET /api/reports and GET /api/reports/:name
 * (normalized report output from @qbv/reports).
 */

export type ColumnType =
  'text' | 'date' | 'datetime' | 'amount' | 'price' | 'quantity' | 'percent' | 'number' | 'boolean';

export interface ReportColumn {
  key: string;
  title: string;
  titles?: string[];
  type: ColumnType;
  qbType?: string;
}

export type RowKind = 'data' | 'text' | 'subtotal' | 'total';
export type CellValue = string | number | boolean | null;

export interface ReportRow {
  kind: RowKind;
  indent: number;
  label?: string;
  cells: Record<string, CellValue>;
  rowType?: string;
  rowValue?: string;
  ref?: { type: string; id: string };
}

export interface ReportMeta {
  name: string;
  title: string;
  subtitle?: string;
  source: 'sql' | 'qb';
  params: Record<string, unknown>;
  generatedAt: string;
  basis?: string;
  fetchedAt?: string;
  expiresAt?: string;
  cached?: boolean;
  commandId?: string;
  rowCount: number;
  notes?: string[];
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, CellValue> | null;
  meta: ReportMeta;
}

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
  group?: 'period' | 'filter' | 'layout';
}

export interface ReportInfo {
  name: string;
  title: string;
  description: string;
  category: string;
  source: 'sql' | 'qb';
  params: ParamDef[];
  qb?: { request: string; typeField: string; typeValue: string };
}

export interface ReportCatalog {
  reports: ReportInfo[];
  categories: string[];
}

export type ParamValue = string | number | boolean | string[] | undefined;
export type ParamValues = Record<string, ParamValue>;
