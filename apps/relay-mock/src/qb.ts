// Catalog-driven helpers shared by the request handlers.
import {
  loadCatalog,
  type Catalog,
  type EntityDef,
  type FieldDef,
  type ObjectDef,
  type RequestDef,
} from '@qbv/qbxml';

/** A QuickBooks status returned in place of a successful response. */
export class QbStatus extends Error {
  readonly code: number;
  readonly severity: 'Info' | 'Warn' | 'Error';
  constructor(code: number, message: string, severity?: 'Info' | 'Warn' | 'Error') {
    super(message);
    this.name = 'QbStatus';
    this.code = code;
    this.severity = severity ?? (code === 0 ? 'Info' : code < 1000 ? 'Warn' : 'Error');
  }
}

// Status codes and messages as QuickBooks words them.
export const status = {
  noMatch: () =>
    new QbStatus(1, 'A query request did not find a matching object in QuickBooks', 'Info'),
  partial: (what: string) =>
    new QbStatus(
      500,
      `The query request has not been fully completed. There was a required element ("${what}") that could not be found in QuickBooks.`,
      'Warn',
    ),
  invalidId: (id: string, field: string) =>
    new QbStatus(3000, `The given object ID "${id}" in the field "${field}" is invalid.`),
  duplicateName: (name: string) =>
    new QbStatus(3100, `The name "${name}" of the list element is already in use.`),
  notFound: (id: string) =>
    new QbStatus(3120, `Object "${id}" specified in the request cannot be found.`),
  badRef: (kind: string, value: string, owner: string) =>
    new QbStatus(
      3140,
      `There is an invalid reference to QuickBooks ${kind} "${value}" in the ${owner}. QuickBooks error message: Invalid argument. The specified record does not exist in the list.`,
    ),
  saveError: (what: string, msg: string) =>
    new QbStatus(
      3180,
      `There was an error when saving a ${what}. QuickBooks error message: ${msg}`,
    ),
  staleEditSequence: (es: string) =>
    new QbStatus(3200, `The provided edit sequence "${es}" is out-of-date. `),
  notSupported: () =>
    new QbStatus(
      3250,
      'This feature is not enabled or not available in this version of QuickBooks.',
    ),
  internal: (msg: string) =>
    new QbStatus(1000, `An internal error occurred in the relay mock: ${msg}`),
};

export function cat(): Catalog {
  return loadCatalog();
}

const fieldMaps = new Map<string, Map<string, FieldDef>>();

export function obj(name: string): ObjectDef {
  const o = cat().objects[name];
  if (!o) throw new Error(`Unknown qbXML object ${name}`);
  return o;
}

export function hasObj(name: string): boolean {
  return cat().objects[name] !== undefined;
}

export function field(o: ObjectDef | string, name: string): FieldDef | undefined {
  const def = typeof o === 'string' ? obj(o) : o;
  let m = fieldMaps.get(def.name);
  if (!m) {
    m = new Map();
    for (const f of def.fields) if (!m.has(f.name)) m.set(f.name, f);
    fieldMaps.set(def.name, m);
  }
  return m.get(name);
}

export function isMany(f: FieldDef): boolean {
  return f.maxOccurs === 'unbounded' || f.maxOccurs > 1;
}

export function childDef(f: FieldDef): ObjectDef {
  return obj(f.children ?? f.type);
}

export function entity(name: string): EntityDef {
  const e = cat().entities[name];
  if (!e) throw new Error(`Unknown entity ${name}`);
  return e;
}

export function request(name: string): RequestDef | undefined {
  return cat().requests[name];
}

/** Entities returned by a union query (ItemQueryRq -> ItemService, ItemInventory, ...). */
export function unionMembers(rq: string): EntityDef[] {
  return Object.values(cat().entities).filter((e) => e.unionQuery === rq);
}

/** Entities that share a name space (a name must be unique across them). */
export function nameSpaceOf(e: EntityDef): string {
  if (e.unionQuery && e.unionQuery !== 'PayrollItemQueryRq') return e.unionQuery;
  if (e.name.startsWith('PayrollItem')) return 'PayrollItem';
  return e.name;
}

export function entityByDelType(kind: 'list' | 'txn', delType: string): EntityDef | undefined {
  return Object.values(cat().entities).find((e) => e.delType === delType && e.category === kind);
}

export function entityByVoidType(voidType: string): EntityDef | undefined {
  return Object.values(cat().entities).find((e) => e.voidType === voidType);
}

/** Line fields of a transaction Ret (InvoiceLineRet, ExpenseLineRet, JournalDebitLine, ...). */
export function lineFields(def: ObjectDef): FieldDef[] {
  return def.fields.filter(
    (f) =>
      f.kind === 'complex' &&
      isMany(f) &&
      /Line/.test(f.name) &&
      !/^LinkedTxn|^ItemGroupLine$/.test(f.name) &&
      f.name !== 'ComponentItemLineRet',
  );
}

/** Choice path of a field as [group, branch] pairs. */
export function choiceOf(f: FieldDef): [string, string][] {
  if (f.choicePath) return f.choicePath.map((p) => p.split(':') as [string, string]);
  if (f.choiceGroup !== undefined) return [[f.choiceGroup, String(f.choiceBranch ?? 0)]];
  return [];
}

/** A record's display name: FullName when the Ret has it, else Name (Initial for sales reps). */
export function fullNameOf(ret: Record<string, unknown>): string | undefined {
  const v = ret.FullName ?? ret.Name ?? ret.Initial;
  return typeof v === 'string' ? v : undefined;
}

export const NAME_ENTITIES = ['Customer', 'Vendor', 'Employee', 'OtherName'];
