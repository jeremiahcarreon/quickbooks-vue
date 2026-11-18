import { detectPreset, MACRO_PRESETS, presetRange, todayLocal } from './presets';
import type { ParamDef, ParamValue, ParamValues, ReportInfo } from './types';

/** Params the form renders specially (period picker), not as generic inputs. */
export const PERIOD_PARAMS = new Set(['from', 'to', 'dateMacro']);

export interface FormState {
  /** Preset id, 'custom', or '' when the report has no date range. */
  preset: string;
  values: ParamValues;
}

export const hasPeriod = (info: ReportInfo): boolean => info.params.some((p) => p.name === 'from');

/** Default preset when nothing is in the URL, following QuickBooks' own defaults. */
export function defaultPreset(info: ReportInfo): string {
  const macro = info.params.find((p) => p.name === 'dateMacro')?.default;
  if (typeof macro === 'string' && MACRO_PRESETS[macro]) return MACRO_PRESETS[macro]!;
  if (info.name.startsWith('Aging.')) return 'today';
  if (info.name.startsWith('BudgetSummary.')) return 'thisYear';
  return 'thisMonthToDate';
}

type Query = Record<string, unknown>;

function fromQuery(def: ParamDef, raw: unknown): ParamValue {
  const vals = (Array.isArray(raw) ? raw : [raw])
    .filter((x): x is string => typeof x === 'string')
    .flatMap((s) => (def.type === 'multiEnum' || def.type === 'multiString' ? s.split(',') : [s]))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!vals.length) return undefined;
  switch (def.type) {
    case 'multiEnum':
    case 'multiString':
      return vals;
    case 'boolean':
      return vals[vals.length - 1] === 'true';
    case 'integer': {
      const n = Number(vals[vals.length - 1]);
      return Number.isInteger(n) ? n : undefined;
    }
    default:
      return vals[vals.length - 1];
  }
}

/** Form state from the route query (shareable links) or the report's defaults. */
export function initialState(info: ReportInfo, query: Query = {}, today = todayLocal()): FormState {
  const values: ParamValues = {};
  for (const def of info.params) {
    if (PERIOD_PARAMS.has(def.name)) continue;
    const q = fromQuery(def, query[def.name]);
    values[def.name] = q !== undefined ? q : def.default;
  }
  if (!hasPeriod(info)) return { preset: '', values };
  const from = typeof query.from === 'string' ? query.from : undefined;
  const to = typeof query.to === 'string' ? query.to : undefined;
  if (from || to) {
    values.from = from;
    values.to = to;
    return { preset: detectPreset({ from, to }, today), values };
  }
  const macro = typeof query.dateMacro === 'string' ? query.dateMacro : undefined;
  const preset = (macro && MACRO_PRESETS[macro]) || defaultPreset(info);
  const range = presetRange(preset, today) ?? {};
  values.from = range.from;
  values.to = range.to;
  return { preset, values };
}

/** Apply a preset to the state (custom keeps the typed dates). */
export function applyPreset(state: FormState, preset: string, today = todayLocal()): FormState {
  if (preset === 'custom') return { ...state, preset };
  const range = presetRange(preset, today) ?? {};
  return { preset, values: { ...state.values, from: range.from, to: range.to } };
}

/** The params to send: empty values dropped, "All Dates" sent as dateMacro=All. */
export function requestParams(info: ReportInfo, state: FormState): ParamValues {
  const out: ParamValues = {};
  for (const [k, v] of Object.entries(state.values)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  if (hasPeriod(info) && !out.from && !out.to && info.params.some((p) => p.name === 'dateMacro')) {
    out.dateMacro = 'All';
  }
  return out;
}

/** Route query mirroring the request params (arrays joined with commas). */
export function toRouteQuery(params: ParamValues): Record<string, string> {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    q[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return q;
}
