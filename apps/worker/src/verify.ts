import type { EntityDef } from '@qbv/qbxml';
import type { Ret } from '@qbv/db';
import { addBodyOfRq, entityOfRq, targetIdOfRq } from './entities.js';
import type { QbLookup } from './lookup.js';
import { objectOf, textOf, type RequestInfo, type RqInfo } from './request-info.js';

/** A write that a follow-up query showed QuickBooks already applied. */
export interface AppliedChange {
  rq: RqInfo;
  entity: EntityDef;
  op: 'add' | 'del';
  qbId: string;
  /** The object as QuickBooks has it now (adds). */
  ret?: Ret;
}

export type Verdict =
  | { action: 'send'; reason: string }
  | { action: 'applied'; reason: string; applied: AppliedChange[] }
  | { action: 'unknown'; reason: string };

type RqVerdict =
  | { action: 'send'; reason: string }
  | { action: 'applied'; reason: string; change: AppliedChange }
  | { action: 'unknown'; reason: string };

function createdSince(ret: Ret, since: Date): boolean {
  const t = Date.parse(textOf(ret.TimeCreated) ?? '');
  return Number.isFinite(t) && t >= since.getTime();
}

function idOfRet(entity: EntityDef, ret: Ret): string | undefined {
  return entity.idField ? textOf(ret[entity.idField]) : undefined;
}

async function verifyRq(lookup: QbLookup, rq: RqInfo, since: Date): Promise<RqVerdict> {
  if (rq.readOnly) return { action: 'send', reason: `${rq.name} is a query` };
  if (rq.op === 'Mod') {
    // A Mod carries the EditSequence it was based on. If the first attempt was
    // applied, QuickBooks rejects the resend with 3200 instead of applying it twice.
    return { action: 'send', reason: `${rq.name} is protected by its EditSequence` };
  }
  if (rq.name === 'TxnVoidRq') {
    return { action: 'send', reason: 'voiding a transaction twice has no further effect' };
  }
  const entity = entityOfRq(rq);
  if (!entity) return { action: 'unknown', reason: `cannot tell which object ${rq.name} changes` };

  if (rq.name === 'ListDelRq' || rq.name === 'TxnDelRq') {
    const id = targetIdOfRq(rq, entity);
    if (!id || !lookup.canQueryById(entity)) {
      return { action: 'unknown', reason: `${entity.name} cannot be looked up by id` };
    }
    const current = await lookup.byId(entity, id);
    return current
      ? { action: 'send', reason: `${entity.name} ${id} still exists` }
      : {
          action: 'applied',
          reason: `${entity.name} ${id} no longer exists in QuickBooks`,
          change: { rq, entity, op: 'del', qbId: id },
        };
  }

  if (rq.op === 'Add') {
    const body = addBodyOfRq(rq);
    if (!body) return { action: 'unknown', reason: `${rq.name} has no ${rq.def?.bodyElement}` };
    const name = textOf(body.Name);
    if (name !== undefined && lookup.canQueryByFullName(entity)) {
      // List names are unique within their list, so a FullName lookup is conclusive.
      const parent = objectOf(body.ParentRef);
      let fullName: string | undefined = name;
      if (parent) {
        const parentName = textOf(parent.FullName);
        fullName = parentName ? `${parentName}:${name}` : undefined;
      }
      if (!fullName) {
        return {
          action: 'unknown',
          reason: 'the parent is given by ListID only, so FullName is unknown',
        };
      }
      const found = (await lookup.byFullName(entity, fullName)).filter((r) =>
        createdSince(r, since),
      );
      const ret = found[0];
      const id = ret ? idOfRet(entity, ret) : undefined;
      if (ret && id) {
        return {
          action: 'applied',
          reason: `${entity.name} "${fullName}" was created at ${textOf(ret.TimeCreated)}`,
          change: { rq, entity, op: 'add', qbId: id, ret },
        };
      }
      return { action: 'send', reason: `no ${entity.name} named "${fullName}" was created` };
    }
    const ref = textOf(body.RefNumber);
    if (ref !== undefined && lookup.canQueryByRefNumber(entity)) {
      const found = (await lookup.byRefNumber(entity, ref)).filter((r) => createdSince(r, since));
      if (found.length > 1) {
        return {
          action: 'unknown',
          reason: `several ${entity.name}s numbered ${ref} were created`,
        };
      }
      const ret = found[0];
      const id = ret ? idOfRet(entity, ret) : undefined;
      if (ret && id) {
        return {
          action: 'applied',
          reason: `${entity.name} ${ref} was created at ${textOf(ret.TimeCreated)}`,
          change: { rq, entity, op: 'add', qbId: id, ret },
        };
      }
      return { action: 'send', reason: `no ${entity.name} numbered ${ref} was created` };
    }
    return {
      action: 'unknown',
      reason: `${entity.name} has no Name or RefNumber in the request to look it up by`,
    };
  }
  return { action: 'unknown', reason: `${rq.name} cannot be checked with a query` };
}

/**
 * Decide what to do with a command whose earlier attempt may have reached
 * QuickBooks (the worker stopped mid-send, or the relay timed out). A write
 * is resent only when a query shows it was not applied, or when resending
 * cannot apply it twice (Mod, TxnVoid). `since` is the earliest time the
 * first attempt could have created an object (start time minus clock skew).
 */
export async function verifyInterrupted(
  lookup: QbLookup,
  info: RequestInfo,
  since: Date,
): Promise<Verdict> {
  if (info.readOnly) return { action: 'send', reason: 'queries are safe to resend' };
  const writes = info.rqs.filter((r) => !r.readOnly);
  const verdicts: RqVerdict[] = [];
  for (const rq of writes) {
    const v = await verifyRq(lookup, rq, since);
    if (v.action === 'unknown') return { action: 'unknown', reason: `${rq.name}: ${v.reason}` };
    verdicts.push(v);
  }
  const applied = verdicts.filter((v) => v.action === 'applied');
  const reason = writes.map((rq, i) => `${rq.name}: ${verdicts[i]!.reason}`).join('; ');
  if (applied.length === 0) return { action: 'send', reason };
  if (applied.length === verdicts.length) {
    return { action: 'applied', reason, applied: applied.map((v) => v.change) };
  }
  return {
    action: 'unknown',
    reason: `only part of the batch was applied (${reason}); resending it would repeat the applied part`,
  };
}
