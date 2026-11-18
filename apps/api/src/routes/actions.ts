import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getObject, type JsonValue } from '@qbv/db';
import { buildRequest, catalog, type EntityDef, type RequestDef } from '@qbv/qbxml';
import { Priority } from '@qbv/queue';
import { typed, type RouteContext } from '../context.js';
import { authorize, can } from '../lib/auth.js';
import { replyWithResponse, submitCommand } from '../lib/commands.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { entityOr404 } from '../lib/meta.js';
import { WaitQuery } from '../lib/query.js';
import { permissionsForRequest, rawRequestAccess } from '../lib/raw-permissions.js';
import { z } from '../lib/zod.js';

const Body = z.record(z.string(), z.unknown());

/** Requests the REST object routes already cover (an entity's Add/Mod/Query/Del/Void or union query). */
function entityRequests(): Set<string> {
  const out = new Set<string>();
  for (const e of Object.values(catalog.entities)) {
    for (const rq of Object.values(e.ops)) if (rq) out.add(rq);
    if (e.unionQuery) out.add(e.unionQuery);
  }
  return out;
}

let actions: RequestDef[] | undefined;
/**
 * SDK requests that are not an operation of a catalog entity: ListMerge,
 * ClearedStatusMod, SpecialAccountAdd/SpecialItemAdd, Txn/ListDisplay*,
 * DataExt/DataExtDef/Alert/Subscription/DataEventRecoveryInfo deletes,
 * QBCommandExec and the cross-entity queries (TransactionQuery,
 * ListDeletedQuery, TxnDeletedQuery). Report queries are served by /reports.
 */
export function actionRequests(): RequestDef[] {
  if (actions) return actions;
  const covered = entityRequests();
  actions = Object.values(catalog.requests)
    .filter((r) => !covered.has(r.name) && !r.name.endsWith('ReportQueryRq'))
    .sort((a, b) => a.name.localeCompare(b.name));
  return actions;
}

function actionOr404(name: string): RequestDef {
  const def = actionRequests().find((r) => r.name === name);
  if (!def) {
    throw notFound(
      catalog.requests[name]
        ? `${name} is served by the object routes or /reports, not /actions`
        : `Unknown qbXML request "${name}"`,
      'unknown_action',
      { request: name },
    );
  }
  return def;
}

function kindOf(def: RequestDef): 'query' | 'raw' {
  return def.op === 'Query' ? 'query' : 'raw';
}

/**
 * Build the document (XSD-validated: an invalid body is a 400 and nothing is
 * queued). With `check`, also require every permission its requests need
 * (routes scoped to one entity type check object:<Type> in their config instead).
 */
function buildAuthorized(
  req: FastifyRequest,
  version: string,
  rq: string,
  body: object,
  check = true,
): string {
  const xml = buildRequest(rq, body, { version });
  if (check) {
    for (const p of new Set(rawRequestAccess(xml).flatMap((a) => a.permissions))) {
      authorize(req, p);
    }
  }
  return xml;
}

function liveQueryOf(e: EntityDef): string {
  const rq = e.ops.query ?? e.unionQuery;
  if (!rq) {
    throw new HttpError(405, 'operation_not_supported', `${e.name} has no query request`, {
      type: e.name,
    });
  }
  return rq;
}

function mergeTypes(): string[] {
  return catalog.objects.ListMergeRq?.fields.find((f) => f.name === 'ListMergeType')?.enum ?? [];
}

export async function actionRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const r = typed(app);
  const { deps } = ctx;
  const version = deps.config.QBXML_VERSION;

  r.get(
    '/actions',
    {
      config: { authenticated: true },
      schema: {
        tags: ['actions'],
        summary: 'SDK requests that are not an entity operation, with the permissions they need',
      },
    },
    async (req) => ({
      actions: actionRequests().map((d) => {
        const permissions = permissionsForRequest(d.name, '');
        return {
          name: d.name,
          op: d.op,
          entity: d.entity ?? null,
          response: d.response,
          permissions,
          allowed: permissions.every((p) => can(req, p)),
        };
      }),
    }),
  );

  r.post(
    '/actions/:request',
    {
      config: { authenticated: true, rateLimit: 'write' },
      schema: {
        tags: ['actions'],
        summary:
          'Send one SDK request that has no object route (ListMergeRq, ClearedStatusModRq, SpecialAccountAddRq, DataExtDelRq, QBCommandExecRq, ...)',
        description:
          'Body: the request element content in qbXML element names, e.g. for SpecialAccountAddRq `{"SpecialAccountAdd":{"SpecialAccountType":"UndepositedFunds"}}`. ' +
          'Built with buildRequest and validated against the XSD (400 when invalid; nothing is queued). ' +
          'Permissions are those POST /qbxml requires for the same request (see GET /actions). ' +
          'Queued at priority 1 (writes) or 2 (queries); `?wait=true` returns `{responses}` parsed from QuickBooks.',
        params: z.object({ request: z.string().min(1).max(100) }),
        querystring: WaitQuery,
        body: Body,
      },
    },
    async (req, reply) => {
      const def = actionOr404(req.params.request);
      const xml = buildAuthorized(req, version, def.name, req.body);
      const command = await submitCommand(deps, req, {
        kind: kindOf(def),
        rq: def.name,
        body: req.body,
        xml,
        objectType: def.entity && catalog.entities[def.entity] ? def.entity : null,
        payload: req.body as JsonValue,
        priority: def.op === 'Query' ? Priority.InteractiveRead : Priority.InteractiveWrite,
        action: 'qbxml.action',
      });
      return replyWithResponse(deps, reply, command, req.query.wait ?? false);
    },
  );

  r.post(
    '/objects/:type/live',
    {
      config: {
        permission: (req) => `object:${(req.params as { type?: string }).type ?? ''}:read`,
      },
      schema: {
        tags: ['objects'],
        summary: 'Live query: ask QuickBooks directly instead of the read model',
        description:
          'For entities whose query needs filters (BillToPay needs PayeeEntityRef, ItemAssembliesCanBuild needs ItemInventoryAssemblyRef, ' +
          'SalesTaxReturnLine needs TaxAgencyVendorRef, subscriptions need SubscriberID, ...) and so cannot be synced, and for any other entity. ' +
          'Body: the query request content in qbXML element names. Built with buildRequest (XSD-validated; 400 when invalid), queued at priority 2. ' +
          'Waits for QuickBooks by default (`?wait=false` returns 202) and returns `{items, responses}`; nothing is written to the read model.',
        params: z.object({ type: z.string().min(1).max(100) }),
        querystring: z.object({ wait: WaitQuery.shape.wait }),
        body: Body.optional(),
      },
    },
    async (req, reply) => {
      const e = entityOr404(req.params.type);
      const rq = liveQueryOf(e);
      const body = req.body ?? {};
      const xml = buildAuthorized(req, version, rq, body, false);
      const command = await submitCommand(deps, req, {
        kind: 'query',
        rq,
        body,
        xml,
        objectType: e.name,
        payload: body as JsonValue,
        priority: Priority.InteractiveRead,
        action: 'object.live_query',
      });
      return replyWithResponse(deps, reply, command, req.query.wait ?? true, (responses) => {
        const rs = responses[0];
        const items =
          rs?.rets.filter((_, i) => (rs.retNames[i] ?? e.retElement) === e.retElement) ?? [];
        return { type: e.name, items, total: items.length };
      });
    },
  );

  r.post(
    '/objects/:type/:id/merge',
    {
      config: {
        permission: (req) => `object:${(req.params as { type?: string }).type ?? ''}:write`,
        rateLimit: 'write',
      },
      schema: {
        tags: ['objects'],
        summary: 'Merge this list record into another one (ListMergeRq)',
        description:
          'Body: `{ into: ListID, sameShipAddrOk?: boolean }`. EditSequences come from the read model unless `fromEditSequence` / `intoEditSequence` are given. ' +
          'Only the list types ListMergeRq supports (Account, Class, Customer, Vendor and most item types).',
        params: z.object({ type: z.string().min(1).max(100), id: z.string().min(1).max(100) }),
        querystring: WaitQuery,
        body: z.object({
          into: z.string().min(1).max(100),
          sameShipAddrOk: z.boolean().optional(),
          fromEditSequence: z.string().min(1).max(16).optional(),
          intoEditSequence: z.string().min(1).max(16).optional(),
        }),
      },
    },
    async (req, reply) => {
      const e = entityOr404(req.params.type);
      if (!mergeTypes().includes(e.name)) {
        throw new HttpError(405, 'operation_not_supported', `${e.name} records cannot be merged`, {
          type: e.name,
          mergeable: mergeTypes(),
        });
      }
      const { into } = req.body;
      if (into === req.params.id)
        throw badRequest('merge_into_self', 'Cannot merge a record into itself');
      const seq = async (id: string, given: string | undefined, label: string) => {
        if (given) return given;
        const row = await getObject(deps.db, e.name, id);
        if (!row) throw notFound(`${e.name} ${id} (${label}) not found in the read model`);
        if (!row.edit_sequence) {
          throw badRequest(
            'edit_sequence_required',
            `${e.name} ${id} has no EditSequence; pass ${label}EditSequence`,
          );
        }
        return row.edit_sequence;
      };
      const body = {
        ListMergeType: e.name,
        MergeFrom: {
          ListID: req.params.id,
          EditSequence: await seq(req.params.id, req.body.fromEditSequence, 'from'),
        },
        MergeTo: { ListID: into, EditSequence: await seq(into, req.body.intoEditSequence, 'into') },
        ...(req.body.sameShipAddrOk !== undefined
          ? { SameShipAddrOk: req.body.sameShipAddrOk }
          : {}),
      };
      const xml = buildAuthorized(req, version, 'ListMergeRq', body, false);
      const command = await submitCommand(deps, req, {
        kind: 'raw',
        rq: 'ListMergeRq',
        body,
        xml,
        objectType: e.name,
        objectId: into,
        payload: req.body as JsonValue,
        action: 'object.merge',
      });
      return replyWithResponse(deps, reply, command, req.query.wait ?? false);
    },
  );

  r.post(
    '/objects/:type/:id/cleared-status',
    {
      config: {
        permission: (req) => `object:${(req.params as { type?: string }).type ?? ''}:write`,
        rateLimit: 'write',
      },
      schema: {
        tags: ['objects'],
        summary:
          'Mark a transaction (or one of its lines) Cleared, NotCleared or Pending (ClearedStatusModRq)',
        params: z.object({ type: z.string().min(1).max(100), id: z.string().min(1).max(100) }),
        querystring: WaitQuery,
        body: z.object({
          status: z.enum(['Cleared', 'NotCleared', 'Pending']),
          txnLineId: z.string().min(1).max(100).optional(),
        }),
      },
    },
    async (req, reply) => {
      const e = entityOr404(req.params.type);
      if (e.idField !== 'TxnID') {
        throw new HttpError(405, 'operation_not_supported', `${e.name} is not a transaction`, {
          type: e.name,
        });
      }
      const mod: Record<string, unknown> = { TxnID: req.params.id };
      if (req.body.txnLineId) mod.TxnLineID = req.body.txnLineId;
      mod.ClearedStatus = req.body.status;
      const body = { ClearedStatusMod: mod };
      const xml = buildAuthorized(req, version, 'ClearedStatusModRq', body, false);
      const command = await submitCommand(deps, req, {
        kind: 'raw',
        rq: 'ClearedStatusModRq',
        body,
        xml,
        objectType: e.name,
        objectId: req.params.id,
        payload: req.body as JsonValue,
        action: 'object.cleared_status',
      });
      return replyWithResponse(deps, reply, command, req.query.wait ?? false);
    },
  );
}
