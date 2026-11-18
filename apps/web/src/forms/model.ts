/**
 * Metadata-driven form model. Everything here is pure and works from the
 * catalog ObjectDefs (served by /api/meta), so the same rules drive:
 *  - which input each field gets (describeObject)
 *  - client-side validation mirroring the XSD (validateValue)
 *  - the JSON body sent to the API (toBody / diffForMod), in the
 *    element-named qbXML shape the API turns into a validated request
 *  - edit forms prefilled from a Ret (fromRet) and conflict reapply.
 *
 * Form values use the qbXML JS shape: element names as keys, simple values as
 * strings ('' = empty), refs as `{ ListID?, FullName? }`, nested objects as
 * records and repeating complex fields ("lines") as arrays. Choice selections
 * are kept under the `__choice` key of the object they belong to and are
 * stripped when serialising.
 */
import type { FieldDef, ObjectDef } from '@/api/types';
import { humanize } from '@/lib/labels';
import { refTargets } from '@/lib/entities';

export interface FormContext {
  objects: Record<string, ObjectDef>;
  /** Every entity name (for ref targets). */
  entityNames: readonly string[];
  /** Entity that owns the form (for ParentRef). */
  owner?: string;
}

export type InputKind =
  | 'text'
  | 'textarea'
  | 'enum'
  | 'number'
  | 'money'
  | 'date'
  | 'datetime'
  | 'bool'
  | 'id'
  | 'guid'
  | 'duration'
  | 'list'
  | 'ref'
  | 'object'
  | 'lines';

export type NumberKind = 'amount' | 'price' | 'quantity' | 'percent' | 'float' | 'integer';

export interface FormField {
  name: string;
  def: FieldDef;
  kind: InputKind;
  label: string;
  /** minOccurs >= 1 (within its choice branch, if any). */
  required: boolean;
  repeating: boolean;
  maxOccurs: number | null;
  numberKind?: NumberKind;
  /** Entity types a ref field searches. */
  refTargets?: string[];
  /** ObjectDef name of an object/lines field. */
  child?: string;
  /** Not shown (EditSequence, TxnLineID, the id of a Mod). */
  hidden: boolean;
  /** Repeating-choice group this lines field belongs to (any of them may hold lines). */
  anyOf?: string;
}

export interface ChoiceBranch {
  index: number;
  label: string;
  items: LayoutItem[];
}

export interface ChoiceItem {
  type: 'choice';
  id: string;
  required: boolean;
  branches: ChoiceBranch[];
}

export type LayoutItem = { type: 'field'; field: FormField } | ChoiceItem;

export interface AnyOfGroup {
  id: string;
  required: boolean;
  fields: string[];
}

export interface ObjectForm {
  name: string;
  fields: FormField[];
  layout: LayoutItem[];
  anyOf: AnyOfGroup[];
}

export type FormValue = Record<string, unknown>;
export type ErrorMap = Record<string, string>;

export const CHOICE_KEY = '__choice';
const SYSTEM_FIELDS = new Set(['EditSequence', 'TxnLineID']);
const ID_FIELDS = new Set(['ListID', 'TxnID']);

// ------------------------------------------------------------------ describe

const cache = new WeakMap<Record<string, ObjectDef>, Map<string, ObjectForm>>();

export function isRefObject(def: ObjectDef | undefined): boolean {
  return (
    !!def &&
    def.fields.length > 0 &&
    def.fields.every((f) => f.kind === 'simple' && (f.name === 'ListID' || f.name === 'FullName'))
  );
}

const NUMBER_KIND: Record<string, NumberKind> = {
  AMTTYPE: 'amount',
  PRICETYPE: 'price',
  QUANTYPE: 'quantity',
  PERCENTTYPE: 'percent',
  FLOATTYPE: 'float',
  INTTYPE: 'integer',
};

function maxOf(f: FieldDef): number | null {
  return f.maxOccurs === 'unbounded' ? null : f.maxOccurs;
}

function fieldOf(objName: string, f: FieldDef, ctx: FormContext, isFirst: boolean): FormField {
  const repeating = f.maxOccurs === 'unbounded' || f.maxOccurs > 1;
  const base: FormField = {
    name: f.name,
    def: f,
    kind: 'text',
    label: humanize(f.name),
    required: f.minOccurs >= 1,
    repeating,
    maxOccurs: maxOf(f),
    hidden: SYSTEM_FIELDS.has(f.name) || (isFirst && ID_FIELDS.has(f.name) && /Mod$/.test(objName)),
  };
  if (f.kind === 'complex') {
    const child = f.children ?? f.type;
    const def = ctx.objects[child];
    if (isRefObject(def) && !repeating) {
      return {
        ...base,
        kind: 'ref',
        child,
        refTargets: refTargets(f.name, ctx.entityNames, ctx.owner),
      };
    }
    return { ...base, kind: repeating ? 'lines' : 'object', child };
  }
  if (repeating) return { ...base, kind: 'list' };
  const nk = NUMBER_KIND[f.type];
  if (nk)
    return {
      ...base,
      kind: nk === 'amount' || nk === 'price' ? 'money' : 'number',
      numberKind: nk,
    };
  switch (f.type) {
    case 'ENUMTYPE':
      return { ...base, kind: f.enum?.length ? 'enum' : 'text' };
    case 'DATETYPE':
      return { ...base, kind: 'date' };
    case 'DATETIMETYPE':
      return { ...base, kind: 'datetime' };
    case 'BOOLTYPE':
      return { ...base, kind: 'bool' };
    case 'IDTYPE':
      return { ...base, kind: 'id' };
    case 'GUIDTYPE':
      return { ...base, kind: 'guid' };
    case 'TIMEINTERVALTYPE':
      return { ...base, kind: 'duration' };
    default:
      if (f.enum?.length) return { ...base, kind: 'enum' };
      return { ...base, kind: (f.maxLength ?? 0) >= 1000 ? 'textarea' : 'text' };
  }
}

function pathOf(f: FieldDef): string[] {
  if (f.choicePath?.length) return f.choicePath;
  if (f.choiceGroup) return [`${f.choiceGroup}:${f.choiceBranch ?? 0}`];
  return [];
}

function splitSeg(seg: string): [string, number] {
  const i = seg.lastIndexOf(':');
  return i < 0 ? [seg, 0] : [seg.slice(0, i), Number(seg.slice(i + 1))];
}

interface Entry {
  field: FormField;
  path: string[];
}

function branchRequired(items: LayoutItem[]): boolean {
  return items.some((it) => (it.type === 'field' ? it.field.required : it.required));
}

function branchLabel(items: LayoutItem[]): string {
  const names: string[] = [];
  const walk = (its: LayoutItem[]) => {
    for (const it of its) {
      if (it.type === 'field') {
        if (!it.field.hidden) names.push(it.field.label);
      } else if (it.branches[0]) walk(it.branches[0].items);
    }
  };
  walk(items);
  if (names.length <= 2) return names.join(' + ');
  return `${names[0]} + ${names.length - 1} more`;
}

function buildLayout(entries: Entry[], depth: number, anyOf: AnyOfGroup[]): LayoutItem[] {
  const out: LayoutItem[] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i]!;
    const seg = e.path[depth];
    if (seg === undefined) {
      out.push({ type: 'field', field: e.field });
      i++;
      continue;
    }
    const [group] = splitSeg(seg);
    const members: Entry[] = [];
    while (i < entries.length) {
      const s = entries[i]!.path[depth];
      if (s === undefined || splitSeg(s)[0] !== group) break;
      members.push(entries[i]!);
      i++;
    }
    const byBranch = new Map<number, Entry[]>();
    for (const m of members) {
      const b = splitSeg(m.path[depth]!)[1];
      byBranch.set(b, [...(byBranch.get(b) ?? []), m]);
    }
    const branches: ChoiceBranch[] = [...byBranch.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, es]) => {
        const items = buildLayout(es, depth + 1, anyOf);
        return { index, label: branchLabel(items), items };
      });
    const required = branches.length > 0 && branches.every((b) => branchRequired(b.items));
    // A choice whose every branch is a single repeating complex field is a
    // repeating choice in practice (InvoiceLineAdd | InvoiceLineGroupAdd,
    // JournalDebitLine | JournalCreditLine): any of them may hold lines.
    const repeatingChoice =
      branches.length > 1 &&
      branches.every(
        (b) =>
          b.items.length === 1 &&
          b.items[0]!.type === 'field' &&
          b.items[0]!.field.kind === 'lines',
      );
    if (repeatingChoice) {
      const names: string[] = [];
      for (const b of branches) {
        const it = b.items[0] as { type: 'field'; field: FormField };
        it.field.required = false;
        it.field.anyOf = group;
        names.push(it.field.name);
        out.push(it);
      }
      anyOf.push({ id: group, required, fields: names });
    } else {
      out.push({ type: 'choice', id: group, required, branches });
    }
  }
  return out;
}

/** Describe an ObjectDef as form fields and a layout (with choice groups). Cached per catalog. */
export function describeObject(name: string, ctx: FormContext): ObjectForm {
  let byName = cache.get(ctx.objects);
  if (!byName) {
    byName = new Map();
    cache.set(ctx.objects, byName);
  }
  const key = `${name}|${ctx.owner ?? ''}|${ctx.entityNames.length}`;
  const hit = byName.get(key);
  if (hit) return hit;
  const def = ctx.objects[name];
  if (!def) throw new Error(`Unknown object definition ${name}`);
  const entries: Entry[] = def.fields.map((f, i) => ({
    field: fieldOf(name, f, ctx, i === 0),
    path: pathOf(f),
  }));
  const anyOf: AnyOfGroup[] = [];
  const layout = buildLayout(entries, 0, anyOf);
  const form: ObjectForm = { name, fields: entries.map((e) => e.field), layout, anyOf };
  byName.set(key, form);
  return form;
}

/** ObjectDef names a form needs (recursively), for prefetching metadata. */
export function requiredObjects(
  name: string,
  objects: Record<string, ObjectDef>,
  seen = new Set<string>(),
): Set<string> {
  if (seen.has(name)) return seen;
  seen.add(name);
  const def = objects[name];
  if (!def) return seen;
  for (const f of def.fields) {
    if (f.kind === 'complex') requiredObjects(f.children ?? f.type, objects, seen);
  }
  return seen;
}

// ------------------------------------------------------------------ values

export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.every(isEmptyValue);
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).every(
      ([k, x]) => k.startsWith('__') || isEmptyValue(x),
    );
  }
  return false;
}

function itemsHaveValue(items: LayoutItem[], value: FormValue): boolean {
  return items.some((it) =>
    it.type === 'field'
      ? !it.field.hidden && !isEmptyValue(value[it.field.name])
      : it.branches.some((b) => itemsHaveValue(b.items, value)),
  );
}

/** Selected branch index of a choice, or -1 for none. */
export function selectedBranch(choice: ChoiceItem, value: FormValue | undefined): number {
  const v = value ?? {};
  const explicit = (v[CHOICE_KEY] as Record<string, number> | undefined)?.[choice.id];
  if (typeof explicit === 'number') return explicit;
  for (const b of choice.branches) if (itemsHaveValue(b.items, v)) return b.index;
  return choice.required ? (choice.branches[0]?.index ?? -1) : -1;
}

export function selectBranch(value: FormValue, choiceId: string, index: number): void {
  const prev = (value[CHOICE_KEY] as Record<string, number> | undefined) ?? {};
  value[CHOICE_KEY] = { ...prev, [choiceId]: index };
}

/** Fields that are active under the current choice selections. */
export function activeFields(form: ObjectForm, value: FormValue | undefined): FormField[] {
  const out: FormField[] = [];
  const walk = (items: LayoutItem[]) => {
    for (const it of items) {
      if (it.type === 'field') out.push(it.field);
      else {
        const b = selectedBranch(it, value);
        const br = it.branches.find((x) => x.index === b);
        if (br) walk(br.items);
      }
    }
  };
  walk(form.layout);
  return out;
}

/** An empty value for a new object (lines start empty). */
export function initialValue(name: string, ctx: FormContext): FormValue {
  const form = describeObject(name, ctx);
  const v: FormValue = {};
  for (const f of form.fields) {
    if (f.kind === 'lines' || f.kind === 'list') v[f.name] = [];
  }
  return v;
}

/** An empty row for a lines field. */
export function newLine(child: string, ctx: FormContext): FormValue {
  return initialValue(child, ctx);
}

// ------------------------------------------------------------------ numbers

/**
 * Normalise a numeric string for its qbXML type. AMTTYPE needs exactly two
 * decimals when it has any (`12.5` -> `12.50`). Returns the input unchanged
 * when it is not a plain number (validation reports it).
 */
export function normalizeNumber(v: string, kind: NumberKind): string {
  const s = v.trim().replace(/,/g, '');
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) return v.trim();
  const int = m[2] || '0';
  const frac = m[3] ?? '';
  if (kind === 'amount') {
    if (frac.length === 0) return `${m[1]}${int}`;
    if (frac.length <= 2) return `${m[1]}${int}.${frac.padEnd(2, '0')}`;
    return s;
  }
  if (kind === 'integer') return frac === '' ? `${m[1]}${int}` : s;
  return frac === '' ? `${m[1]}${int}` : `${m[1]}${int}.${frac}`;
}

// ------------------------------------------------------------------ serialise

function simpleOut(f: FormField, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === 'object' && '#text' in (v as object))
    return simpleOut(f, (v as Record<string, unknown>)['#text']);
  const s = String(v);
  if (s === '') return undefined;
  if (f.numberKind) return normalizeNumber(s, f.numberKind);
  return s;
}

function refOut(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: Record<string, string> = {};
  if (typeof o.ListID === 'string' && o.ListID) out.ListID = o.ListID;
  if (typeof o.FullName === 'string' && o.FullName) out.FullName = o.FullName;
  return Object.keys(out).length ? out : undefined;
}

function fieldOut(f: FormField, v: unknown, ctx: FormContext): unknown {
  switch (f.kind) {
    case 'ref':
      return refOut(v);
    case 'object':
      return v && typeof v === 'object' ? toBody(f.child!, v as FormValue, ctx) : undefined;
    case 'lines': {
      const rows = (Array.isArray(v) ? v : [])
        .map((r) =>
          r && typeof r === 'object' ? toBody(f.child!, r as FormValue, ctx) : undefined,
        )
        .filter((r): r is Record<string, unknown> => !!r);
      return rows.length ? rows : undefined;
    }
    case 'list': {
      const items = (Array.isArray(v) ? v : [])
        .map((x) => simpleOut(f, x))
        .filter((x) => x !== undefined);
      return items.length ? items : undefined;
    }
    default:
      return simpleOut(f, v);
  }
}

/**
 * Serialise a form value into the request body (element-named JSON), keeping
 * only the active choice branches and dropping empty values. Returns
 * undefined when nothing is left.
 */
export function toBody(
  name: string,
  value: FormValue,
  ctx: FormContext,
): Record<string, unknown> | undefined {
  const form = describeObject(name, ctx);
  const out: Record<string, unknown> = {};
  for (const f of activeFields(form, value)) {
    const v = fieldOut(f, value[f.name], ctx);
    if (v !== undefined) out[f.name] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// ------------------------------------------------------------------ validate

const PATTERNS: Partial<Record<NumberKind, RegExp>> = {
  amount: /^[+-]?\d{1,13}(\.\d{2})?$/,
  price: /^[+-]?\d{1,10}(\.\d{1,5})?$/,
  quantity: /^[+-]?\d{1,10}(\.\d{1,5})?$/,
  percent: /^[+-]?\d{1,10}(\.\d{1,5})?$/,
  float: /^[+-]?(\d+(\.\d*)?|\.\d+)$/,
  integer: /^[+-]?\d+$/,
};

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Error message for one simple value, or null. Mirrors the XSD facets. */
export function validateSimple(f: FormField, raw: unknown): string | null {
  const s = simpleOut(f, raw);
  if (s === undefined) return null;
  const d = f.def;
  if (f.numberKind) {
    if (!PATTERNS[f.numberKind]!.test(s)) {
      if (f.numberKind === 'amount') return 'Enter an amount with up to 2 decimals';
      if (f.numberKind === 'integer') return 'Enter a whole number';
      if (f.numberKind === 'float') return 'Enter a number';
      return 'Enter a number with up to 5 decimals';
    }
    const n = Number(s);
    if (d.minInclusive !== undefined && n < d.minInclusive)
      return `Must be at least ${d.minInclusive}`;
    if (d.maxInclusive !== undefined && n > d.maxInclusive)
      return `Must be at most ${d.maxInclusive}`;
    return null;
  }
  switch (f.kind) {
    case 'enum':
      return d.enum && !d.enum.includes(s) ? 'Choose one of the listed values' : null;
    case 'date':
      return validDate(s) ? null : 'Enter a date (YYYY-MM-DD)';
    case 'datetime':
      return /^\d{4}-\d{1,2}-\d{1,2}(T\d{1,2}(:\d{1,2}(:\d{1,2}([+-]\d{1,2}:\d{1,2})?)?)?)?$/.test(
        s,
      )
        ? null
        : 'Enter a date and time';
    case 'bool':
      return s === 'true' || s === 'false' ? null : 'Must be yes or no';
    case 'guid':
      return /^(0|\{[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\})$/.test(s)
        ? null
        : 'Enter a GUID like {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}';
    case 'duration':
      return /^[+-]?PT(\d+H)?(\d+M)?(\d+S)?$/.test(s) ? null : 'Enter a duration like PT8H30M';
  }
  if (d.maxLength !== undefined && [...s].length > d.maxLength) {
    return `At most ${d.maxLength} characters`;
  }
  if (d.enum?.length && !d.enum.includes(s)) return 'Choose one of the listed values';
  return null;
}

/**
 * Validate a form value against the catalog rules (required by minOccurs,
 * choice groups, maxLength, enums, numeric/date formats, maxOccurs).
 * Keys are field paths: `Name`, `BillAddress.Addr1`, `InvoiceLineAdd[0].Rate`;
 * a choice group's key is `<prefix>#<groupId>`.
 */
export function validateValue(
  name: string,
  value: FormValue,
  ctx: FormContext,
  prefix = '',
): ErrorMap {
  const errors: ErrorMap = {};
  const form = describeObject(name, ctx);
  const v = value ?? {};
  const walk = (items: LayoutItem[]) => {
    for (const it of items) {
      if (it.type === 'choice') {
        const b = selectedBranch(it, v);
        const br = it.branches.find((x) => x.index === b);
        if (!br) {
          if (it.required) errors[`${prefix}#${it.id}`] = 'Choose one of the options';
        } else walk(br.items);
        continue;
      }
      const f = it.field;
      const path = `${prefix}${f.name}`;
      const fv = v[f.name];
      const empty = isEmptyValue(fv);
      if (empty) {
        if (f.required && !f.hidden) {
          errors[path] = f.kind === 'lines' ? 'Add at least one line' : 'Required';
        }
        continue;
      }
      if (f.kind === 'ref') {
        const r = refOut(fv);
        if (r?.FullName && f.def && ctx.objects[f.child!]) {
          const fn = ctx.objects[f.child!]!.fields.find((x) => x.name === 'FullName');
          if (fn?.maxLength && r.FullName.length > fn.maxLength) {
            errors[path] = `At most ${fn.maxLength} characters`;
          }
        }
      } else if (f.kind === 'object') {
        Object.assign(errors, validateValue(f.child!, fv as FormValue, ctx, `${path}.`));
      } else if (f.kind === 'lines') {
        const rows = (fv as unknown[]).filter((r) => !isEmptyValue(r));
        if (f.maxOccurs !== null && rows.length > f.maxOccurs)
          errors[path] = `At most ${f.maxOccurs} lines`;
        (fv as unknown[]).forEach((row, i) => {
          if (!isEmptyValue(row)) {
            Object.assign(errors, validateValue(f.child!, row as FormValue, ctx, `${path}[${i}].`));
          }
        });
      } else if (f.kind === 'list') {
        (fv as unknown[]).forEach((x, i) => {
          const e = validateSimple(f, x);
          if (e) errors[`${path}[${i}]`] = e;
        });
      } else {
        const e = validateSimple(f, fv);
        if (e) errors[path] = e;
      }
    }
  };
  walk(form.layout);
  for (const g of form.anyOf) {
    if (g.required && g.fields.every((n) => isEmptyValue(v[n]))) {
      errors[`${prefix}${g.fields[0]}`] = 'Add at least one line';
    }
  }
  return errors;
}

// ------------------------------------------------------------------ from Ret

function textOf(v: unknown): string {
  if (Array.isArray(v)) return textOf(v[0]);
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') {
    const t = (v as Record<string, unknown>)['#text'];
    return t === undefined || t === null ? '' : String(t);
  }
  return String(v);
}

/** Source key in a Ret for a Mod/Add field: same name, or `XxxLineMod` -> `XxxLineRet`. */
function retKey(ret: Record<string, unknown>, name: string): string {
  if (name in ret) return name;
  const alt = name.replace(/(Mod|Add)$/, 'Ret');
  return alt in ret ? alt : name;
}

/** Prefill a form value (Add or Mod shape) from a Ret / read-model `data`. */
export function fromRet(
  name: string,
  ret: Record<string, unknown> | undefined,
  ctx: FormContext,
): FormValue {
  const form = describeObject(name, ctx);
  const src = ret ?? {};
  const v: FormValue = {};
  for (const f of form.fields) {
    const raw = src[retKey(src, f.name)];
    switch (f.kind) {
      case 'ref': {
        const r = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
        if (r && typeof r === 'object') {
          v[f.name] = {
            ...(r.ListID ? { ListID: textOf(r.ListID) } : {}),
            ...(r.FullName ? { FullName: textOf(r.FullName) } : {}),
          };
        }
        break;
      }
      case 'object': {
        const r = Array.isArray(raw) ? raw[0] : raw;
        if (r && typeof r === 'object')
          v[f.name] = fromRet(f.child!, r as Record<string, unknown>, ctx);
        break;
      }
      case 'lines':
        v[f.name] = (Array.isArray(raw) ? raw : raw ? [raw] : [])
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .map((r) => fromRet(f.child!, r, ctx));
        break;
      case 'list':
        v[f.name] = (Array.isArray(raw) ? raw : raw !== undefined ? [raw] : []).map(textOf);
        break;
      default:
        if (raw !== undefined) v[f.name] = textOf(raw);
    }
  }
  return v;
}

// ------------------------------------------------------------------ Mod diff

const CLEARABLE = new Set([
  'STRTYPE',
  'AMTTYPE',
  'PRICETYPE',
  'QUANTYPE',
  'PERCENTTYPE',
  'DATETYPE',
]);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function lineIdOf(row: unknown): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const id = (row as Record<string, unknown>).TxnLineID;
  return typeof id === 'string' && id && id !== '-1' ? id : undefined;
}

function linesForMod(
  f: FormField,
  base: unknown,
  edited: unknown,
  ctx: FormContext,
): Record<string, unknown>[] {
  const baseRows = new Map<string, Record<string, unknown> | undefined>();
  for (const r of Array.isArray(base) ? base : []) {
    const id = lineIdOf(r);
    if (id) baseRows.set(id, toBody(f.child!, r as FormValue, ctx));
  }
  const childForm = describeObject(f.child!, ctx);
  const hasLineId = childForm.fields.some((x) => x.name === 'TxnLineID');
  const out: Record<string, unknown>[] = [];
  for (const r of Array.isArray(edited) ? edited : []) {
    if (!r || typeof r !== 'object' || isEmptyValue(r)) continue;
    const body = toBody(f.child!, r as FormValue, ctx) ?? {};
    const id = lineIdOf(r);
    if (id && baseRows.has(id) && same(baseRows.get(id), body)) {
      out.push({ TxnLineID: id });
    } else if (hasLineId && !id) {
      out.push({ TxnLineID: '-1', ...body });
    } else {
      out.push(body);
    }
  }
  return out;
}

/**
 * Body for a Mod request: the id and EditSequence (and any other required
 * field), plus only the fields that changed from `base` (the form value
 * prefilled from the Ret). Cleared text/amount/date fields are sent empty so
 * QuickBooks clears them. If any line changed, every line is sent (an omitted
 * line is deleted by QuickBooks); unchanged lines are sent as their TxnLineID
 * only and new lines get TxnLineID -1.
 */
export function diffForMod(
  name: string,
  base: FormValue,
  edited: FormValue,
  ctx: FormContext,
): Record<string, unknown> {
  const form = describeObject(name, ctx);
  const out: Record<string, unknown> = {};
  for (const f of activeFields(form, edited)) {
    const bv = base[f.name];
    const ev = edited[f.name];
    const eOut = fieldOut(f, ev, ctx);
    if (f.required && !f.anyOf && (f.kind !== 'lines' || eOut !== undefined)) {
      if (f.kind === 'lines') out[f.name] = linesForMod(f, bv, ev, ctx);
      else if (eOut !== undefined) out[f.name] = eOut;
      continue;
    }
    const bOut = fieldOut(f, bv, ctx);
    if (same(bOut, eOut)) continue;
    if (f.kind === 'lines') {
      out[f.name] = linesForMod(f, bv, ev, ctx);
      continue;
    }
    if (eOut === undefined) {
      if (f.def.kind === 'simple' && CLEARABLE.has(f.def.type) && f.kind !== 'list')
        out[f.name] = '';
      continue;
    }
    out[f.name] = eOut;
  }
  // Lines removed entirely: QuickBooks keeps lines when none are sent, so an
  // emptied lines field cannot be expressed; it is left out.
  for (const k of Object.keys(out)) {
    if (Array.isArray(out[k]) && (out[k] as unknown[]).length === 0) delete out[k];
  }
  return out;
}

/**
 * Reload-and-reapply after an EditSequence conflict: start from the current
 * Ret (fresh EditSequence) and put back every field the user had submitted.
 * Lines sent as TxnLineID-only are taken from the current object.
 */
export function reapply(
  name: string,
  current: Record<string, unknown>,
  submitted: Record<string, unknown>,
  ctx: FormContext,
): FormValue {
  const draft = fromRet(name, current, ctx);
  const mine = fromRet(name, submitted, ctx);
  const form = describeObject(name, ctx);
  for (const f of form.fields) {
    if (!(f.name in submitted) || f.name === 'EditSequence' || (f.hidden && ID_FIELDS.has(f.name)))
      continue;
    if (f.kind === 'lines') {
      const currentRows = new Map<string, FormValue>();
      for (const r of (draft[f.name] as FormValue[] | undefined) ?? []) {
        const id = lineIdOf(r);
        if (id) currentRows.set(id, r);
      }
      const rows: FormValue[] = [];
      for (const r of (mine[f.name] as FormValue[] | undefined) ?? []) {
        const id = lineIdOf(r);
        const onlyId = Object.entries(r).every(([k, x]) => k === 'TxnLineID' || isEmptyValue(x));
        if (id && onlyId) {
          const cur = currentRows.get(id);
          if (cur) rows.push(cur);
        } else {
          rows.push(r.TxnLineID === '-1' ? { ...r, TxnLineID: '' } : r);
        }
      }
      draft[f.name] = rows;
    } else {
      draft[f.name] = mine[f.name] ?? '';
    }
  }
  return draft;
}

// ------------------------------------------------------------------ diff view

export interface DiffRow {
  path: string;
  label: string;
  mine: string;
  current: string;
  base?: string;
  /** Someone else changed it since the edit began. */
  changedRemotely: boolean;
  /** Mine differs from what is in QuickBooks now. */
  differs: boolean;
}

const SKIP_DIFF = new Set([
  'ListID',
  'TxnID',
  'EditSequence',
  'TxnLineID',
  'TimeModified',
  'TimeCreated',
]);

/** Flatten to leaf paths; refs become their FullName (or ListID), lines are keyed by TxnLineID. */
export function flatten(
  v: unknown,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  if (v === undefined || v === null) return out;
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      const id = lineIdOf(x);
      const isNew = !id && (x as Record<string, unknown> | null)?.TxnLineID === '-1';
      flatten(x, `${prefix}[${id ?? (isNew ? `new${i}` : i)}]`, out);
    });
    return out;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#text' in o) {
      out[prefix] = String(o['#text'] ?? '');
      return out;
    }
    const keys = Object.keys(o);
    if (keys.length && keys.every((k) => k === 'ListID' || k === 'FullName')) {
      out[prefix] = String(o.FullName ?? o.ListID ?? '');
      return out;
    }
    for (const [k, x] of Object.entries(o)) {
      if (k.startsWith('__') || k.startsWith('@')) continue;
      flatten(x, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  out[prefix] = String(v);
  return out;
}

/** Map Mod/Add element names in a path to their Ret names (InvoiceLineMod -> InvoiceLineRet). */
function toRetPath(path: string): string {
  return path.replace(/([A-Za-z]+?)(Mod|Add)(?=\[|\.|$)/g, '$1Ret');
}

/** Line number (1-based, in the submitted order) of every TxnLineID. */
function linePositions(v: unknown, out = new Map<string, number>()): Map<string, number> {
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      const id = lineIdOf(x);
      if (id) out.set(id, i + 1);
      linePositions(x, out);
    });
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) linePositions(x, out);
  }
  return out;
}

function labelOfPath(path: string, positions: Map<string, number>): string {
  return path
    .split('.')
    .map((seg) => {
      const m = /^([^[]+)(\[(.+)\])?$/.exec(seg);
      if (!m) return seg;
      const label = humanize(m[1]!.replace(/(Mod|Add|Ret)$/, ''));
      const key = m[3];
      if (!key) return label;
      if (/^\d+$/.test(key)) return `${label} ${Number(key) + 1}`;
      if (key.startsWith('new')) return `${label} (new)`;
      const pos = positions.get(key);
      return pos ? `${label} ${pos}` : label;
    })
    .join(' / ');
}

/**
 * Field-by-field comparison for the conflict view: every field the user
 * submitted, what QuickBooks has now, and (when known) what it was when the
 * edit began.
 */
export function fieldDiff(
  submitted: Record<string, unknown>,
  current: Record<string, unknown>,
  base?: Record<string, unknown>,
): DiffRow[] {
  const mine = flatten(submitted);
  const cur = flatten(current);
  const was = base ? flatten(base) : undefined;
  const positions = linePositions(submitted);
  const rows: DiffRow[] = [];
  for (const [path, value] of Object.entries(mine)) {
    const leaf = path
      .split('.')
      .pop()!
      .replace(/\[.*\]$/, '');
    if (SKIP_DIFF.has(leaf)) continue;
    const curValue = cur[path] ?? cur[toRetPath(path)] ?? '';
    const baseValue = was ? (was[path] ?? was[toRetPath(path)] ?? '') : undefined;
    rows.push({
      path,
      label: labelOfPath(path, positions),
      mine: value,
      current: curValue,
      ...(baseValue !== undefined ? { base: baseValue } : {}),
      changedRemotely: baseValue !== undefined && baseValue !== curValue,
      differs: value !== curValue,
    });
  }
  return rows;
}

// ------------------------------------------------------------------ server errors

export interface MappedErrors {
  fields: ErrorMap;
  general: string[];
}

function normalizeErrorPath(p: unknown, root: string): string | null {
  let segs: string[];
  if (Array.isArray(p)) segs = p.map((x) => (typeof x === 'number' ? `[${x}]` : String(x)));
  else if (typeof p === 'string') segs = p.split(/[./]/).filter(Boolean);
  else return null;
  // drop everything up to and including the root element / "body"
  const rootIdx = segs.findIndex((s) => s === root || s.replace(/\[\d+\]$/, '') === root);
  if (rootIdx >= 0) segs = segs.slice(rootIdx + 1);
  else if (segs[0] === 'body') segs = segs.slice(1);
  if (!segs.length) return null;
  // XPath-ish `Line[2]` is 1-based
  const oneBased = typeof p === 'string' && p.startsWith('/');
  let out = '';
  for (const s of segs) {
    if (/^\[\d+\]$/.test(s)) {
      out += s;
      continue;
    }
    const m = /^([^[]+)\[(\d+)\]$/.exec(s);
    const part = m ? `${m[1]}[${Number(m[2]) - (oneBased ? 1 : 0)}]` : s;
    out += out ? `.${part}` : part;
  }
  return out;
}

/**
 * Map an API error's `details` onto form fields. Understands arrays of
 * `{ path | field, message }` (Zod-style or XPath-style paths), `{ fields: {path: msg} }`,
 * `{ errors: [...] }` (libxml2: "Element 'Name': ...") and falls back to
 * general messages.
 */
export function mapServerErrors(details: unknown, root: string, form?: ObjectForm): MappedErrors {
  const res: MappedErrors = { fields: {}, general: [] };
  if (!details) return res;
  const d = details as Record<string, unknown>;
  if (d && typeof d === 'object' && !Array.isArray(d) && d.fields && typeof d.fields === 'object') {
    for (const [k, msg] of Object.entries(d.fields as Record<string, unknown>)) {
      const p = normalizeErrorPath(k, root) ?? k;
      res.fields[p] = String(msg);
    }
  }
  const list: unknown[] = Array.isArray(details)
    ? details
    : Array.isArray(d.errors)
      ? d.errors
      : Array.isArray(d.issues)
        ? d.issues
        : [];
  const topNames = new Set(form?.fields.map((f) => f.name) ?? []);
  for (const e of list) {
    if (!e || typeof e !== 'object') {
      res.general.push(String(e));
      continue;
    }
    const o = e as Record<string, unknown>;
    const msg = String(o.message ?? 'Invalid value');
    let path = normalizeErrorPath(o.path ?? o.field, root);
    if (!path) {
      const m = /Element '([^']+)'/.exec(msg);
      if (m && topNames.has(m[1]!)) path = m[1]!;
    }
    if (path) res.fields[path] = res.fields[path] ? `${res.fields[path]}; ${msg}` : msg;
    else res.general.push(msg);
  }
  return res;
}
