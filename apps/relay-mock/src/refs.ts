// Resolve *Ref elements (CustomerRef, ItemRef, AccountRef, ...) against the
// store: fill both ListID and FullName, or fail with QuickBooks' 3140.
import { type ObjectDef } from '@qbv/qbxml';
import type { Engine } from './engine.js';
import { cat, childDef, field, fullNameOf, NAME_ENTITIES, status, unionMembers } from './qb.js';
import { type Rec } from './store.js';
import { arr, isObj, text, type Json } from './util.js';

let itemEntities: string[] | undefined;
export function ITEM_ENTITIES(): string[] {
  return (itemEntities ??= unionMembers('ItemQueryRq').map((e) => e.name));
}
const TERMS = ['StandardTerms', 'DateDrivenTerms'];

const EXPLICIT: Record<string, string[] | (() => string[])> = {
  CustomerRef: ['Customer'],
  VendorRef: ['Vendor'],
  PrefVendorRef: ['Vendor'],
  TaxVendorRef: ['Vendor'],
  EmployeeRef: ['Employee'],
  SupervisorRef: ['Employee'],
  SalesRepEntityRef: ['Employee', 'Vendor', 'OtherName'],
  EntityRef: NAME_ENTITIES,
  PayeeEntityRef: NAME_ENTITIES,
  ItemRef: ITEM_ENTITIES,
  ItemGroupRef: ['ItemGroup'],
  ItemSalesTaxRef: ['ItemSalesTax', 'ItemSalesTaxGroup'],
  ItemPurchaseTaxRef: ['ItemSalesTax', 'ItemSalesTaxGroup'],
  ClassRef: ['Class'],
  OverrideClassRef: ['Class'],
  DiscountClassRef: ['Class'],
  TermsRef: TERMS,
  SalesTaxCodeRef: ['SalesTaxCode'],
  CustomerSalesTaxCodeRef: ['SalesTaxCode'],
  PurchaseTaxCodeRef: ['SalesTaxCode'],
  SalesRepRef: ['SalesRep'],
  PaymentMethodRef: ['PaymentMethod'],
  PreferredPaymentMethodRef: ['PaymentMethod'],
};

const LABEL: Record<string, string> = {
  Customer: 'Customer:Job',
  StandardTerms: 'Terms',
  DateDrivenTerms: 'Terms',
};

/** Which entities a ref element may point at, or undefined when it is not checked. */
export function refTargets(refName: string, owner: string): string[] | undefined {
  if (refName === 'ParentRef') return ITEM_ENTITIES().includes(owner) ? ITEM_ENTITIES() : [owner];
  const x = EXPLICIT[refName];
  if (x) return typeof x === 'function' ? x() : x;
  if (/AccountRef$/.test(refName)) return ['Account'];
  const base = refName.replace(/^(Override|Preferred|Default)/, '').replace(/Ref$/, '');
  const e = cat().entities[base];
  if (e && e.category === 'list') return [e.name];
  return undefined;
}

function label(targets: string[]): string {
  if (targets.length > 1 && targets.every((t) => ITEM_ENTITIES().includes(t))) return 'Item';
  if (targets.length > 1 && targets.every((t) => NAME_ENTITIES.includes(t))) return 'Name';
  const t = targets[0]!;
  if (t.startsWith('Item')) return 'Item';
  return LABEL[t] ?? t.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Look a ref up: ListID first, then FullName (case-insensitive). */
export function lookupRef(engine: Engine, targets: string[], ref: Json): Rec | undefined {
  const id = text(ref.ListID);
  if (id) return engine.findById(targets, id);
  const name = text(ref.FullName);
  if (name) return engine.findByName(targets, name);
  return undefined;
}

/** A Ret-shaped ref to a record, limited to the elements the ref type has. */
export function refTo(rec: Rec, refDef?: ObjectDef): Json {
  const out: Json = {};
  const id = text(rec.ret.ListID) ?? text(rec.ret.TxnID);
  const name = fullNameOf(rec.ret);
  if (id && (!refDef || field(refDef, 'ListID'))) out.ListID = id;
  if (name && (!refDef || field(refDef, 'FullName'))) out.FullName = name;
  return out;
}

/** Resolve every known ref in `o` (recursively). Throws QbStatus 3140 on a dangling ref. */
export function resolveRefs(engine: Engine, o: Json, def: ObjectDef, owner: string): void {
  for (const f of def.fields) {
    if (f.kind !== 'complex' || !(f.name in o)) continue;
    const cdef = childDef(f);
    const isRef = /Ref$/.test(f.name) && field(cdef, 'ListID') && field(cdef, 'FullName');
    const items = arr(o[f.name]).filter(isObj);
    if (!isRef) {
      for (const item of items) resolveRefs(engine, item, cdef, owner);
      continue;
    }
    const targets = refTargets(f.name, owner);
    if (!targets) continue;
    const resolved = items.map((ref) => {
      if (!text(ref.ListID) && !text(ref.FullName)) return ref;
      const rec = lookupRef(engine, targets, ref);
      if (!rec) {
        throw status.badRef(
          label(targets),
          text(ref.FullName) ?? text(ref.ListID) ?? '',
          owner.replace(/([a-z])([A-Z])/g, '$1 $2'),
        );
      }
      return refTo(rec, cdef);
    });
    o[f.name] = Array.isArray(o[f.name]) ? resolved : resolved[0];
  }
}

/** Every ListID referenced anywhere inside a Ret (used for "in use" checks). */
export function referencedIds(ret: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(ret)) {
    for (const x of ret) referencedIds(x, out);
  } else if (isObj(ret)) {
    for (const [key, v] of Object.entries(ret)) {
      if (/Ref$/.test(key)) {
        for (const r of arr(v)) if (isObj(r) && typeof r.ListID === 'string') out.add(r.ListID);
      } else if (typeof v === 'object') referencedIds(v, out);
    }
  }
  return out;
}
