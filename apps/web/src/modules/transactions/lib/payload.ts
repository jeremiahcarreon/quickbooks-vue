/**
 * Form state <-> qbXML-shaped JSON bodies.
 *
 * Bodies use element names as keys (DESIGN section 6.1) and are emitted in
 * schema order: specs list fields in catalog order, and `orderBody()` re-sorts
 * against /api/meta field definitions when those are loaded. The API builds
 * the qbXML with @qbv/qbxml, which validates it against the XSD before
 * anything is queued.
 */
import { lineAmount, isBlankLine } from './calc';
import { fmtAmount, normAmount, normPrice, parseDec } from './decimal';
import type { MetaDefs } from './api';
import { refIn, refOut } from './refs';
import type {
  Address,
  HeaderField,
  LineColumn,
  LineSection,
  TxnFormState,
  TxnLine,
  TxnSpec,
} from './types';

type Json = Record<string, unknown>;

export const ADDRESS_FIELDS: (keyof Address)[] = [
  'Addr1',
  'Addr2',
  'Addr3',
  'Addr4',
  'Addr5',
  'City',
  'State',
  'PostalCode',
  'Country',
  'Note',
];

/** TxnLineID that tells QuickBooks a Mod line is new. */
export const NEW_LINE_ID = '-1';

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

function boolOut(v: unknown): string | undefined {
  if (v === true || v === 'true') return 'true';
  if (v === false || v === 'false') return 'false';
  return undefined;
}

function addressOut(v: unknown): Address | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const a = v as Record<string, unknown>;
  const out: Address = {};
  for (const k of ADDRESS_FIELDS) {
    const x = str(a[k]).trim();
    if (x) out[k] = x;
  }
  return Object.keys(out).length ? out : undefined;
}

function dateOut(v: unknown): string | undefined {
  const s = str(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

/** Convert one form value to its wire form; undefined means "omit". */
export function valueOut(kind: HeaderField['kind'] | LineColumn['kind'], v: unknown): unknown {
  switch (kind) {
    case 'ref':
      return refOut(v) ?? undefined;
    case 'date':
      return dateOut(v);
    case 'bool':
      return boolOut(v);
    case 'amount':
      return normAmount(v) || undefined;
    case 'price':
    case 'qty':
      return normPrice(v) || undefined;
    case 'address':
      return addressOut(v);
    case 'enum':
    case 'text':
    case 'textarea': {
      const s = str(v).trim();
      return s ? s : undefined;
    }
  }
}

function lineOut(section: LineSection, line: TxnLine, mode: 'add' | 'mod'): Json {
  const out: Json = {};
  if (mode === 'mod') out.TxnLineID = line.TxnLineID || NEW_LINE_ID;
  const p = section.pricing;
  // Which pricing inputs to send: quantity + rate (QB computes the amount), or
  // quantity + amount when the amount was typed (QB derives the rate).
  const rate = p ? parseDec(line.values[p.rate]) : null;
  const sendAmountInstead = !!p && (line.lastEdited === 'amount' || rate === null);
  for (const col of section.columns) {
    if (mode === 'mod' && col.addOnly) continue;
    if (p && col.name === p.rate && sendAmountInstead) continue;
    if (p && col.name === p.amount) {
      if (!sendAmountInstead) continue;
      const typed = parseDec(line.values[p.amount]);
      if (typed !== null) out[col.name] = fmtAmount(lineAmount(section, line));
      continue;
    }
    const v = valueOut(col.kind, line.values[col.name]);
    if (v !== undefined) out[col.name] = v;
  }
  return out;
}

/** Header-level pricing (Statement Charge) follows the same rule as a line. */
function applyHeaderPricing(spec: TxnSpec, state: TxnFormState, out: Json): void {
  const p = spec.headerPricing;
  if (!p) return;
  const rate = parseDec(state.header[p.rate]);
  const lastEdited = state.header.__lastEdited;
  if (lastEdited === 'amount' || rate === null) delete out[p.rate];
  else delete out[p.amount];
}

/**
 * Build the Add or Mod body for a spec-driven form. For Mod the body carries
 * TxnID and EditSequence first, as the schema requires, and every non-blank
 * line (existing lines keep their TxnLineID, new ones get -1).
 */
export function buildBody(
  spec: TxnSpec,
  state: TxnFormState,
  mode: 'add' | 'mod',
  defs?: MetaDefs,
): Json {
  const out: Json = {};
  if (mode === 'mod') {
    if (!state.TxnID || !state.EditSequence) {
      throw new Error('A modification needs the TxnID and EditSequence of the loaded transaction.');
    }
    out.TxnID = state.TxnID;
    out.EditSequence = state.EditSequence;
  }
  for (const field of spec.header) {
    if (mode === 'mod' && field.addOnly) continue;
    if (mode === 'add' && field.modOnly) continue;
    const v = valueOut(field.kind, state.header[field.name]);
    if (v !== undefined) out[field.name] = v;
  }
  applyHeaderPricing(spec, state, out);
  for (const section of spec.lines) {
    const lines = (state.lines[section.key] ?? []).filter((l) => !isBlankLine(section, l));
    const element = mode === 'add' ? section.add : section.mod;
    if (lines.length > 0) out[element] = lines.map((l) => lineOut(section, l, mode));
    else if (mode === 'mod' && section.clearFlag && state.loadedSections?.includes(section.key)) {
      out[section.clearFlag] = 'true';
    }
  }
  const objName = mode === 'add' ? spec.addObject : (spec.modObject ?? spec.addObject);
  return defs && defs.size ? orderBody(out, objName, defs) : orderBySpec(spec, out, mode);
}

/** Order keys the way the spec lists them (schema order), with Clear flags before their lines. */
function orderBySpec(spec: TxnSpec, body: Json, mode: 'add' | 'mod'): Json {
  const order: string[] = mode === 'mod' ? ['TxnID', 'EditSequence'] : [];
  order.push(...spec.header.map((h) => h.name));
  for (const s of spec.lines) {
    if (mode === 'mod' && s.clearFlag) order.push(s.clearFlag);
    order.push(mode === 'add' ? s.add : s.mod);
  }
  const out: Json = {};
  for (const k of order) if (k in body) out[k] = body[k];
  for (const k of Object.keys(body)) if (!(k in out)) out[k] = body[k];
  return out;
}

/**
 * Re-order a body (recursively) into the field order of `objName` from meta
 * definitions. Keys the definition does not know keep their relative order
 * at the end, so the server can report them.
 */
export function orderBody(body: Json, objName: string, defs: MetaDefs): Json {
  const def = defs.get(objName);
  if (!def) return body;
  const index = new Map(def.fields.map((f, i) => [f.name, i]));
  const keys = Object.keys(body).sort((a, b) => {
    const ia = index.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ib = index.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
  const out: Json = {};
  for (const k of keys) {
    const field = def.fields.find((f) => f.name === k);
    const child = field?.children ?? (field?.kind === 'complex' ? field.type : undefined);
    const v = body[k];
    if (child && defs.has(child)) {
      if (Array.isArray(v)) {
        out[k] = v.map((x) => (x && typeof x === 'object' ? orderBody(x as Json, child, defs) : x));
      } else if (v && typeof v === 'object') out[k] = orderBody(v as Json, child, defs);
      else out[k] = v;
    } else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ret -> form state

function arr(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object') as Json[];
  if (v && typeof v === 'object') return [v as Json];
  return [];
}

function valueIn(kind: HeaderField['kind'] | LineColumn['kind'], v: unknown): unknown {
  const x = Array.isArray(v) ? v[0] : v;
  switch (kind) {
    case 'ref':
      return refIn(x);
    case 'bool':
      return x === 'true' || x === true ? true : x === 'false' || x === false ? false : undefined;
    case 'address':
      return x && typeof x === 'object' ? { ...(x as Json) } : undefined;
    default:
      return x === undefined || x === null ? '' : str(x);
  }
}

/** Element names of grouped lines; a transaction that has them is not editable here. */
export function groupLineElements(spec: TxnSpec): string[] {
  return spec.lines.map((s) =>
    s.ret.replace(/LineRet$/, 'LineGroupRet').replace(/^ItemLineGroupRet$/, 'ItemGroupLineRet'),
  );
}

export interface LoadedState {
  state: TxnFormState;
  /** Why lines cannot be edited from this screen, if they cannot. */
  readOnlyReason?: string;
}

export function stateFromRet(spec: TxnSpec, ret: Json): LoadedState {
  const header: Json = {};
  for (const f of spec.header) {
    const v = valueIn(f.kind, ret[f.name]);
    if (v !== undefined && v !== '') header[f.name] = v;
  }
  if (spec.headerPricing && ret[spec.headerPricing.rate] === undefined) {
    header.__lastEdited = 'amount';
  }
  const lines: Record<string, TxnLine[]> = {};
  const loadedSections: string[] = [];
  for (const s of spec.lines) {
    lines[s.key] = arr(ret[s.ret]).map((r, i) => {
      const values: Json = {};
      for (const c of s.columns) {
        const v = valueIn(c.kind, r[c.name]);
        if (v !== undefined && v !== '') values[c.name] = v;
      }
      const hasRate = s.pricing ? values[s.pricing.rate] !== undefined : false;
      return {
        key: `${str(r.TxnLineID) || 'r'}-${i}`,
        TxnLineID: str(r.TxnLineID) || undefined,
        values,
        lastEdited: s.pricing && !hasRate ? 'amount' : undefined,
      } satisfies TxnLine;
    });
    if (lines[s.key]!.length) loadedSections.push(s.key);
  }
  const groups = groupLineElements(spec).filter((g) => arr(ret[g]).length > 0);
  return {
    state: {
      TxnID: str(ret.TxnID) || undefined,
      EditSequence: str(ret.EditSequence) || undefined,
      header,
      lines,
      loadedSections,
    },
    readOnlyReason: groups.length
      ? 'This transaction contains item group lines, which this screen cannot edit without losing them. Edit it in QuickBooks Desktop.'
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Client-side checks (lengths, enums, required) before submitting

export interface FormIssue {
  field: string;
  message: string;
  /** Line section key and line index, for line issues. */
  section?: string;
  line?: number;
}

function lengthOf(defs: MetaDefs | undefined, obj: string, field: string, fallback?: number) {
  return defs?.get(obj)?.fields.find((f) => f.name === field)?.maxLength ?? fallback;
}

function enumOf(defs: MetaDefs | undefined, obj: string, field: string, fallback?: string[]) {
  return defs?.get(obj)?.fields.find((f) => f.name === field)?.enum ?? fallback;
}

export function checkForm(
  spec: TxnSpec,
  state: TxnFormState,
  mode: 'add' | 'mod',
  defs?: MetaDefs,
): FormIssue[] {
  const issues: FormIssue[] = [];
  const objName = mode === 'add' ? spec.addObject : (spec.modObject ?? spec.addObject);
  for (const f of spec.header) {
    if ((mode === 'mod' && f.addOnly) || (mode === 'add' && f.modOnly)) continue;
    const raw = state.header[f.name];
    const out = valueOut(f.kind, raw);
    if (f.required && out === undefined)
      issues.push({ field: f.name, message: `${f.label} is required.` });
    if (
      (f.kind === 'amount' || f.kind === 'price' || f.kind === 'qty') &&
      str(raw).trim() &&
      out === undefined
    ) {
      issues.push({ field: f.name, message: `${f.label} is not a number.` });
    }
    if (typeof out === 'string') {
      const max = lengthOf(defs, objName, f.name, f.maxLength);
      if (max && out.length > max) {
        issues.push({ field: f.name, message: `${f.label} is longer than ${max} characters.` });
      }
      const allowed = f.kind === 'enum' ? enumOf(defs, objName, f.name, f.options) : undefined;
      if (allowed && !allowed.includes(out)) {
        issues.push({ field: f.name, message: `${f.label} must be one of ${allowed.join(', ')}.` });
      }
    }
  }
  let used = 0;
  for (const s of spec.lines) {
    const lineObj = mode === 'add' ? s.add : s.mod;
    (state.lines[s.key] ?? []).forEach((line, i) => {
      if (isBlankLine(s, line)) return;
      used += 1;
      for (const c of s.columns) {
        const raw = line.values[c.name];
        const out = valueOut(c.kind, raw);
        if (
          (c.kind === 'amount' || c.kind === 'price' || c.kind === 'qty') &&
          str(raw).trim() &&
          out === undefined
        ) {
          issues.push({
            field: c.name,
            section: s.key,
            line: i,
            message: `Line ${i + 1}: ${c.label} is not a number.`,
          });
        }
        if (
          typeof out === 'string' &&
          c.kind !== 'amount' &&
          c.kind !== 'price' &&
          c.kind !== 'qty'
        ) {
          const max = lengthOf(defs, lineObj, c.name, c.maxLength);
          if (max && out.length > max) {
            issues.push({
              field: c.name,
              section: s.key,
              line: i,
              message: `Line ${i + 1}: ${c.label} is longer than ${max} characters.`,
            });
          }
        }
      }
      if (!valueOut('ref', line.values[s.keyColumn]) && s.keyColumn === 'AccountRef') {
        issues.push({
          field: s.keyColumn,
          section: s.key,
          line: i,
          message: `Line ${i + 1}: choose an account.`,
        });
      }
    });
  }
  if (spec.requireLine && used === 0)
    issues.push({ field: 'lines', message: 'Add at least one line.' });
  return issues;
}
