import { getEntity, loadCatalog, type EntityDef } from '@qbv/qbxml';
import { objectOf, textOf, type RqInfo } from './request-info.js';

function findEntity(pred: (e: EntityDef) => boolean): EntityDef | undefined {
  return Object.values(loadCatalog().entities).find(pred);
}

/** The entity a request acts on (Add/Mod/Query from the catalog, Del/Void from the type element). */
export function entityOfRq(rq: RqInfo): EntityDef | undefined {
  if (rq.def?.entity) {
    try {
      return getEntity(rq.def.entity);
    } catch {
      return undefined;
    }
  }
  switch (rq.name) {
    case 'ListDelRq': {
      const t = textOf(rq.body.ListDelType);
      return t ? findEntity((e) => e.delType === t && e.ops.del === 'ListDelRq') : undefined;
    }
    case 'TxnDelRq': {
      const t = textOf(rq.body.TxnDelType);
      return t ? findEntity((e) => e.delType === t && e.ops.del === 'TxnDelRq') : undefined;
    }
    case 'TxnVoidRq': {
      const t = textOf(rq.body.TxnVoidType);
      return t ? findEntity((e) => e.voidType === t) : undefined;
    }
    default:
      return undefined;
  }
}

/** Entity of a Del/Void response element (ListDelRs, TxnDelRs, TxnVoidRs) from its type element. */
export function entityOfDelOrVoidRs(
  rsName: string,
  body: Record<string, unknown>,
): { entity: EntityDef; id: string } | undefined {
  let entity: EntityDef | undefined;
  let id: string | undefined;
  if (rsName === 'ListDelRs') {
    const t = textOf(body.ListDelType);
    entity = t ? findEntity((e) => e.delType === t && e.ops.del === 'ListDelRq') : undefined;
    id = textOf(body.ListID);
  } else if (rsName === 'TxnDelRs') {
    const t = textOf(body.TxnDelType);
    entity = t ? findEntity((e) => e.delType === t && e.ops.del === 'TxnDelRq') : undefined;
    id = textOf(body.TxnID);
  } else if (rsName === 'TxnVoidRs') {
    const t = textOf(body.TxnVoidType);
    entity = t ? findEntity((e) => e.voidType === t) : undefined;
    id = textOf(body.TxnID);
  }
  return entity && id ? { entity, id } : undefined;
}

/** The ListID/TxnID a Mod, Del or Void request targets. */
export function targetIdOfRq(rq: RqInfo, entity: EntityDef | undefined): string | undefined {
  if (rq.op === 'Mod' && rq.def?.bodyElement) {
    const b = objectOf(rq.body[rq.def.bodyElement]);
    if (!b) return undefined;
    return textOf(entity?.idField ? b[entity.idField] : (b.ListID ?? b.TxnID));
  }
  if (rq.name === 'ListDelRq') return textOf(rq.body.ListID);
  if (rq.name === 'TxnDelRq' || rq.name === 'TxnVoidRq') return textOf(rq.body.TxnID);
  return undefined;
}

/** Content of the Add element of an Add request (e.g. CustomerAdd). */
export function addBodyOfRq(rq: RqInfo): Record<string, unknown> | undefined {
  if (rq.op !== 'Add' || !rq.def?.bodyElement) return undefined;
  return objectOf(rq.body[rq.def.bodyElement]);
}

/** The ObjectChanged op for a write request. */
export function changeOpOfRq(rq: RqInfo): 'add' | 'mod' | 'del' | 'void' | undefined {
  if (rq.op === 'Add') return 'add';
  if (rq.op === 'Mod') return 'mod';
  if (rq.op === 'Del' || rq.name === 'ListDelRq' || rq.name === 'TxnDelRq') return 'del';
  if (rq.op === 'Void' || rq.name === 'TxnVoidRq') return 'void';
  return undefined;
}
