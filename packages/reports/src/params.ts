import { isIsoDate } from './dates.js';
import type { ParamDef, ReportParams } from './types.js';

export class ReportError extends Error {
  /** HTTP-ish status for route handlers. */
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ReportError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ParamIssue {
  param: string;
  message: string;
}

export class ReportParamError extends ReportError {
  readonly issues: ParamIssue[];
  constructor(issues: ParamIssue[]) {
    super(
      400,
      'invalid_params',
      `Invalid report parameters: ${issues.map((i) => `${i.param}: ${i.message}`).join('; ')}`,
      issues,
    );
    this.name = 'ReportParamError';
    this.issues = issues;
  }
}

export type RawParams = Record<string, unknown>;

function list(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .flatMap((x) => (typeof x === 'string' ? x.split(',') : x == null ? [] : [String(x)]))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function scalar(v: unknown): string | undefined {
  const x = Array.isArray(v) ? v[v.length - 1] : v;
  if (x === undefined || x === null) return undefined;
  const s = String(x).trim();
  return s === '' ? undefined : s;
}

/**
 * Coerce raw (query-string) values to typed params using the definitions.
 * Unknown keys are ignored; defaults fill missing values; every problem is
 * collected and thrown together as ReportParamError.
 */
export function coerceParams(defs: readonly ParamDef[], raw: RawParams): ReportParams {
  const out: ReportParams = {};
  const issues: ParamIssue[] = [];
  for (const def of defs) {
    const value = raw[def.name];
    const add = (message: string) => issues.push({ param: def.name, message });
    switch (def.type) {
      case 'multiEnum':
      case 'multiString': {
        let vals = list(value);
        if (vals.length === 0 && Array.isArray(def.default)) vals = [...def.default];
        if (def.type === 'multiEnum' && def.options) {
          const bad = vals.filter((v) => !def.options!.includes(v));
          if (bad.length) {
            add(`unknown value(s) ${bad.join(', ')}`);
            continue;
          }
        }
        if (vals.length) out[def.name] = [...new Set(vals)];
        else if (def.required) add('is required');
        continue;
      }
      default:
        break;
    }
    const s = scalar(value);
    if (s === undefined) {
      if (def.default !== undefined && !Array.isArray(def.default)) out[def.name] = def.default;
      else if (def.required) add('is required');
      continue;
    }
    switch (def.type) {
      case 'date':
        if (!isIsoDate(s)) add('must be a date (YYYY-MM-DD)');
        else out[def.name] = s;
        break;
      case 'enum':
        if (def.options && !def.options.includes(s)) {
          add(`must be one of ${def.options.join(', ')}`);
        } else out[def.name] = s;
        break;
      case 'boolean':
        if (['true', '1', 'yes', 'on'].includes(s.toLowerCase())) out[def.name] = true;
        else if (['false', '0', 'no', 'off'].includes(s.toLowerCase())) out[def.name] = false;
        else add('must be true or false');
        break;
      case 'integer':
        if (!/^-?\d+$/.test(s)) add('must be an integer');
        else out[def.name] = Number(s);
        break;
      case 'string':
        if (s.length > 200) add('is too long');
        else out[def.name] = s;
        break;
    }
  }
  if (typeof out.from === 'string' && typeof out.to === 'string' && out.from > out.to) {
    issues.push({ param: 'from', message: 'must not be after "to"' });
  }
  if (issues.length) throw new ReportParamError(issues);
  return out;
}
