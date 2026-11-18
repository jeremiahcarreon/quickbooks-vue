import { getEntity, loadCatalog, type EntityDef } from './catalog.js';

type Ret = Record<string, unknown>;

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && '#text' in v) {
    const t = (v as { '#text': unknown })['#text'];
    return typeof t === 'string' ? t : undefined;
  }
  return undefined;
}

/** ListID / TxnID of a Ret, using the entity's idField from the catalog. */
export function idOf(entity: string | EntityDef, ret: Ret): string | undefined {
  const e = typeof entity === 'string' ? getEntity(entity) : entity;
  if (!e.idField) return undefined;
  return str(ret[e.idField]);
}

/** EditSequence of a Ret (required by every Mod request). */
export function editSequenceOf(ret: Ret): string | undefined {
  return str(ret.EditSequence);
}

/** Display name of a Ret: FullName, Name, then RefNumber. */
export function nameOf(ret: Ret): string | undefined {
  return str(ret.FullName) ?? str(ret.Name) ?? str(ret.RefNumber);
}

/** The ListID of a reference element such as CustomerRef. */
export function refId(ref: unknown): string | undefined {
  return ref && typeof ref === 'object' ? str((ref as Ret).ListID) : undefined;
}

/** Entity definition for a Ret element name (CustomerRet -> Customer). */
export function entityOfRet(retName: string): EntityDef | undefined {
  const e = loadCatalog().entities[retName.replace(/Ret$/, '')];
  return e && e.retElement === retName ? e : undefined;
}

/** Entities that can be listed (have a query op or a union query). */
export function queryableEntities(): EntityDef[] {
  return Object.values(loadCatalog().entities).filter((e) => e.ops.query ?? e.unionQuery);
}
