import {
  catalog,
  getEntity,
  type EntityDef,
  type FieldDef,
  type ObjectDef,
  type RequestDef,
} from '@qbv/qbxml';
import { notFound } from './errors.js';

/**
 * UI-facing view of the qbXML catalog. Nothing is stripped from the catalog
 * definitions; reference fields additionally carry `ref`, the entity (or
 * entities, for union references such as ItemRef) they point at.
 */
export interface FieldView extends FieldDef {
  ref?: string[];
}
export interface ObjectView extends Omit<ObjectDef, 'fields'> {
  fields: FieldView[];
}

let unions: Record<string, string[]> | undefined;
function entityUnions(): Record<string, string[]> {
  if (unions) return unions;
  const ents = Object.values(catalog.entities);
  const items = ents
    .filter((e) => e.name.startsWith('Item') && e.category === 'list' && e.idField === 'ListID')
    .map((e) => e.name)
    .sort();
  const has = (n: string) => !!catalog.entities[n];
  const names = (...n: string[]) => n.filter(has);
  unions = {
    Item: items,
    Terms: names('StandardTerms', 'DateDrivenTerms'),
    Entity: names('Customer', 'Vendor', 'Employee', 'OtherName'),
    PayrollItem: ents
      .filter((e) => e.name.startsWith('PayrollItem'))
      .map((e) => e.name)
      .sort(),
  };
  return unions;
}

/** Field-name specific targets the name heuristic cannot find. */
const REF_OVERRIDES: Record<string, string | string[]> = {
  ParentRef: 'self',
  SupervisorRef: ['Employee'],
  ParentSiteRef: ['InventorySite'],
  PurchaseTaxCodeRef: ['SalesTaxCode'],
  ItemPurchaseTaxRef: ['ItemSalesTax'],
  OverrideUOMSetRef: ['UnitOfMeasureSet'],
};

function camelParts(s: string): string[] {
  return s.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [s];
}

function lookup(base: string): string[] | undefined {
  if (catalog.entities[base]) return [base];
  return entityUnions()[base];
}

/** Entities a `XxxRef` field points at, or undefined when it is not a list reference. */
export function refTargets(field: FieldDef, selfEntity?: string): string[] | undefined {
  if (field.kind !== 'complex' || !field.name.endsWith('Ref') || !field.children) return undefined;
  const child = catalog.objects[field.children];
  if (!child || !child.fields.some((f) => f.name === 'ListID')) return undefined;
  const o = REF_OVERRIDES[field.name];
  if (o === 'self') return selfEntity ? [selfEntity] : undefined;
  if (Array.isArray(o)) return o.filter((n) => catalog.entities[n]);
  const base = field.name.slice(0, -3);
  const direct = lookup(base);
  if (direct) return direct;
  const parts = camelParts(base);
  for (let i = 1; i < parts.length; i++) {
    const hit = lookup(parts.slice(i).join(''));
    if (hit) return hit;
  }
  return undefined;
}

function objectView(name: string, selfEntity?: string): ObjectView | undefined {
  const o = catalog.objects[name];
  if (!o) return undefined;
  return {
    ...o,
    fields: o.fields.map((f) => {
      const ref = refTargets(f, selfEntity);
      return ref ? { ...f, ref } : { ...f };
    }),
  };
}

/** The object plus every object reachable through its complex fields. */
export function objectClosure(roots: string[], selfEntity?: string): Record<string, ObjectView> {
  const out: Record<string, ObjectView> = {};
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop()!;
    if (out[n]) continue;
    const v = objectView(n, selfEntity);
    if (!v) continue;
    out[n] = v;
    for (const f of v.fields) if (f.children && !out[f.children]) stack.push(f.children);
  }
  return out;
}

/** Filters QuickBooks requires on the entity's query; non-empty means sync cannot load it. */
export function requiredQueryFilters(e: EntityDef): string[] {
  const rq = e.ops.query ?? e.unionQuery;
  const obj = rq ? catalog.objects[rq] : undefined;
  return obj ? obj.fields.filter((f) => f.minOccurs > 0).map((f) => f.name) : [];
}

export function entitySummary(e: EntityDef) {
  const required = requiredQueryFilters(e);
  const queryable = !!(e.ops.query ?? e.unionQuery);
  return {
    name: e.name,
    category: e.category,
    idField: e.idField,
    ops: e.ops,
    retElement: e.retElement,
    supportsModifiedFilter: e.supportsModifiedFilter,
    modifiedFilter: e.modifiedFilter ?? null,
    supportsIterator: e.supportsIterator ?? false,
    unionQuery: e.unionQuery ?? null,
    delType: e.delType ?? null,
    voidType: e.voidType ?? null,
    hasEditSequence: e.hasEditSequence ?? false,
    keyFields: e.keyFields ?? [],
    /** True when the entity has a query request (the read model or a live query can list it). */
    listable: queryable,
    /** True when sync fills the read model; false means use POST /objects/:type/live. */
    syncable: queryable && required.length === 0,
    /** Query filters QuickBooks requires (live query form fields). */
    requiredFilters: required,
  };
}

export function listEntities() {
  return Object.values(catalog.entities)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entitySummary);
}

/** Resolve an entity by name or throw 404 with a "did you mean" hint. */
export function entityOr404(type: string): EntityDef {
  try {
    return getEntity(type);
  } catch (err) {
    throw notFound((err as Error).message, 'unknown_type', { type });
  }
}

const detailCache = new Map<string, ReturnType<typeof buildDetail>>();

function buildDetail(e: EntityDef) {
  const requests: Partial<Record<keyof EntityDef['ops'], RequestDef>> = {};
  for (const [op, rq] of Object.entries(e.ops) as [keyof EntityDef['ops'], string][]) {
    const def = catalog.requests[rq];
    if (def) requests[op] = def;
  }
  const roots = {
    add: requests.add?.bodyElement ?? null,
    mod: requests.mod?.bodyElement ?? null,
    ret: e.retElement,
    query: e.ops.query ?? e.unionQuery ?? null,
  };
  const objects = objectClosure(
    [roots.add, roots.mod, roots.ret, roots.query].filter((x): x is string => !!x),
    e.name,
  );
  return { entity: entitySummary(e), requests, roots, objects };
}

export function entityDetail(e: EntityDef) {
  let d = detailCache.get(e.name);
  if (!d) {
    d = buildDetail(e);
    detailCache.set(e.name, d);
  }
  return d;
}

export function listRequests() {
  return Object.values(catalog.requests)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({
      name: r.name,
      response: r.response,
      op: r.op,
      entity: r.entity ?? null,
      supportsIterator: r.supportsIterator,
      msgSet: r.msgSet,
    }));
}
