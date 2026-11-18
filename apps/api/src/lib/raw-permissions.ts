import { catalog, entityForRet, type RequestDef } from '@qbv/qbxml';

/** One request element of a qbXML document and the permissions it needs. */
export interface RawRequestAccess {
  name: string;
  permissions: string[];
}

const ADMIN = 'admin';
const ANY_READ = 'object:*:read';
const ANY_WRITE = 'object:*:write';

const isEntity = (name: string | undefined): name is string => !!name && !!catalog.entities[name];

/** Text of the first `<tag>value</tag>` inside a request element. */
function firstText(content: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</${tag}>`).exec(content);
  return m?.[1];
}

/** Entity whose ListDelType / TxnDelType / TxnVoidType is `value`. */
function entityByType(kind: 'del' | 'void', rq: string, value: string): string | undefined {
  for (const e of Object.values(catalog.entities)) {
    if (kind === 'del' && e.ops.del === rq && e.delType === value) return e.name;
    if (kind === 'void' && e.ops.void === rq && e.voidType === value) return e.name;
  }
  return undefined;
}

function retEntities(def: RequestDef): string[] {
  const out = new Set<string>();
  for (const r of def.retElements ?? []) {
    const e = entityForRet(r);
    if (e) out.add(e.name);
  }
  return [...out];
}

/**
 * Permissions one request needs, on top of qbxml:raw. Reads need
 * object:<Type>:read for every entity the response can return, writes need
 * object:<Type>:write, report queries need report:*, and requests that act on
 * QuickBooks itself (UI display, command exec, subscriptions) need admin.
 * Anything not recognised needs admin.
 */
export function permissionsForRequest(name: string, content: string): string[] {
  const def = catalog.requests[name];
  if (!def) return [ADMIN];
  const perm = (entity: string, access: 'read' | 'write') => `object:${entity}:${access}`;

  if (def.op === 'Query') {
    if (name.endsWith('ReportQueryRq')) return ['report:*'];
    if (isEntity(def.entity)) return [perm(def.entity, 'read')];
    const rets = retEntities(def);
    if (rets.length) return rets.map((e) => perm(e, 'read'));
    // Cross-entity queries (TransactionQuery, ListDeletedQuery, TxnDeletedQuery).
    return [ANY_READ];
  }

  switch (name) {
    case 'ListDelRq':
    case 'TxnDelRq': {
      const type = firstText(content, name === 'ListDelRq' ? 'ListDelType' : 'TxnDelType');
      const e = type ? entityByType('del', name, type) : undefined;
      return [e ? perm(e, 'write') : ADMIN];
    }
    case 'TxnVoidRq': {
      const type = firstText(content, 'TxnVoidType');
      const e = type ? entityByType('void', name, type) : undefined;
      return [e ? perm(e, 'write') : ADMIN];
    }
    case 'ListMergeRq': {
      const type = firstText(content, 'ListMergeType');
      return [isEntity(type) ? perm(type, 'write') : ANY_WRITE];
    }
    case 'ClearedStatusModRq':
      return [ANY_WRITE];
    case 'DataExtDelRq':
      return [perm('DataExt', 'write')];
    case 'DataExtDefDelRq':
      return [perm('DataExtDef', 'write')];
    case 'AlertDelRq':
      return [perm('Alert', 'write')];
    case 'DataEventRecoveryInfoDelRq':
      return [perm('DataEventRecoveryInfo', 'write')];
    default:
      break;
  }

  if (def.op === 'Add' || def.op === 'Mod' || def.op === 'Del' || def.op === 'Void') {
    if (isEntity(def.entity)) return [perm(def.entity, 'write')];
    // SpecialItemAdd can create several item types.
    const rets = def.op === 'Add' ? retEntities(def) : [];
    if (rets.length) return rets.map((e) => perm(e, 'write'));
  }
  // TxnDisplay*/ListDisplay* (open QuickBooks windows), QBCommandExec,
  // SubscriptionDel and anything else that is not an entity operation.
  return [ADMIN];
}

/** Request elements of an XSD-valid request document with the permissions each needs. */
export function rawRequestAccess(xml: string): RawRequestAccess[] {
  const out: RawRequestAccess[] = [];
  const set = /<(QBXML(?:Subscription)?MsgsRq)(?:\s[^>]*)?>([\s\S]*)<\/\1\s*>/.exec(xml);
  if (!set) return out;
  // Request elements never nest, so each one ends at its own closing tag.
  const re = /<([A-Za-z0-9]+Rq)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
  for (const m of set[2]!.matchAll(re)) {
    out.push({ name: m[1]!, permissions: permissionsForRequest(m[1]!, m[2] ?? '') });
  }
  return out;
}
