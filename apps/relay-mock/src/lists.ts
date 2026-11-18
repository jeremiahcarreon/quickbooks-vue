// List semantics: names, FullName / Sublevel for hierarchical lists, unique
// names within a name space, opening balances.
import { type EntityDef, type ObjectDef } from '@qbv/qbxml';
import type { Engine } from './engine.js';
import { cat, field, fullNameOf, nameSpaceOf, status } from './qb.js';
import { type Rec } from './store.js';
import { isObj, lower, num, text, type Json } from './util.js';

function deriveName(ret: Json): string | undefined {
  const person = [text(ret.FirstName), text(ret.MiddleName), text(ret.LastName)]
    .filter(Boolean)
    .join(' ');
  return person || text(ret.CompanyName) || text(ret.Initial);
}

/** Entities sharing the record's name space. */
export function nameSpaceMembers(e: EntityDef): string[] {
  const ns = nameSpaceOf(e);
  return Object.values(cat().entities)
    .filter((x) => x.category === 'list' && nameSpaceOf(x) === ns)
    .map((x) => x.name);
}

function parentOf(engine: Engine, e: EntityDef, ret: Json): Rec | undefined {
  if (!isObj(ret.ParentRef)) return undefined;
  const id = text(ret.ParentRef.ListID);
  if (!id) return undefined;
  return engine.findById(nameSpaceMembers(e), id);
}

/** Set FullName / Sublevel from Name and ParentRef. */
export function applyHierarchy(
  engine: Engine,
  e: EntityDef,
  ret: Json,
  def: ObjectDef,
  selfKey?: string,
): void {
  const name = text(ret.Name);
  if (!name) return;
  const parent = parentOf(engine, e, ret);
  if (parent && selfKey !== undefined) {
    // A record cannot become its own ancestor.
    let p: Rec | undefined = parent;
    while (p) {
      if (p.key === selfKey)
        throw status.saveError(e.name, 'A list element cannot be a subitem of itself.');
      p = parentOf(engine, e, p.ret);
    }
  }
  if (field(def, 'FullName')) {
    const parentName = parent ? fullNameOf(parent.ret) : undefined;
    ret.FullName = parentName ? `${parentName}:${name}` : name;
  }
  if (field(def, 'Sublevel'))
    ret.Sublevel = String(parent ? (num(parent.ret.Sublevel) ?? 0) + 1 : 0);
  if (!parent) delete ret.ParentRef;
}

function checkUnique(engine: Engine, e: EntityDef, ret: Json, selfKey?: string): void {
  const name = fullNameOf(ret);
  if (!name) return;
  const n = lower(name);
  for (const ent of nameSpaceMembers(e)) {
    for (const r of engine.store.all(ent)) {
      if (r.key !== selfKey && lower(fullNameOf(r.ret)) === n) throw status.duplicateName(name);
    }
  }
}

/** Prepare a new or modified list record before it is stored. */
export function prepareList(
  engine: Engine,
  e: EntityDef,
  ret: Json,
  def: ObjectDef,
  input: Json,
  meta: Json,
  selfKey?: string,
): void {
  if (field(def, 'Name') && !text(ret.Name)) {
    const n = deriveName(ret);
    if (n) {
      const f = field(def, 'Name')!;
      ret.Name = f.maxLength ? n.slice(0, f.maxLength) : n;
    }
  }
  applyHierarchy(engine, e, ret, def, selfKey);
  checkUnique(engine, e, ret, selfKey);
  if (field(def, 'IsActive') && ret.IsActive === undefined) ret.IsActive = 'true';
  if (input.OpenBalance !== undefined && selfKey === undefined) {
    meta.openBalance = text(input.OpenBalance);
    meta.openBalanceDate = text(input.OpenBalanceDate) ?? engine.today();
  }
}

/** After a rename or move, update the FullName / Sublevel of every descendant. */
export function cascadeHierarchy(engine: Engine, e: EntityDef, parent: Rec): void {
  const members = nameSpaceMembers(e);
  for (const ent of members) {
    for (const child of engine.store.all(ent)) {
      if (!isObj(child.ret.ParentRef) || child.ret.ParentRef.ListID !== parent.key) continue;
      const updated = engine.update(child, (ret) => {
        ret.ParentRef = { ListID: parent.key, FullName: fullNameOf(parent.ret) };
        applyHierarchy(engine, engine.entityOf(ent), ret, engine.retDefOf(ent));
        engine.touchStamp(ret, ret);
      });
      cascadeHierarchy(engine, engine.entityOf(ent), updated);
    }
  }
}
