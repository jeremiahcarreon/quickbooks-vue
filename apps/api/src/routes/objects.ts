import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getObject, parseFilterParam, queryObjects, type JsonValue } from '@qbv/db';
import { catalog, type EntityDef } from '@qbv/qbxml';
import { typed, type RouteContext } from '../context.js';
import { replyWithCommand, submitCommand } from '../lib/commands.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { entityOr404 } from '../lib/meta.js';
import { filterParams, WaitQuery, zFlag } from '../lib/query.js';
import { objectView } from '../lib/views.js';
import { z } from '../lib/zod.js';

const typeOf = (req: FastifyRequest) => (req.params as { type?: string }).type ?? '';
const readPerm = (req: FastifyRequest) => `object:${typeOf(req)}:read`;
const writePerm = (req: FastifyRequest) => `object:${typeOf(req)}:write`;

const TypeParams = z.object({ type: z.string().min(1).max(100) });
const IdParams = TypeParams.extend({ id: z.string().min(1).max(100) });
const Body = z.record(z.string(), z.unknown());

const ListQuery = z.looseObject({
  q: z.string().max(200).optional(),
  sort: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
  includeInactive: zFlag,
  includeDeleted: zFlag,
});

function unsupported(e: EntityDef, op: string): HttpError {
  return new HttpError(
    405,
    'operation_not_supported',
    `${e.name} does not support ${op} through this endpoint; see GET /actions or use POST /qbxml`,
    { type: e.name, op },
  );
}

function requireIdEntity(e: EntityDef, op: string): 'ListID' | 'TxnID' {
  if (!e.idField) throw unsupported(e, op);
  return e.idField;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export async function objectRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const r = typed(app);
  const { deps } = ctx;

  r.get(
    '/objects/:type',
    {
      config: { permission: readPerm },
      schema: {
        tags: ['objects'],
        summary: 'List objects from the read model',
        description:
          'Filters: `filter[Field]=value` with optional operator prefix (`ne:`, `lt:`, `lte:`, `gt:`, `gte:`, `like:`, `in:a,b`, `isnull:`, `notnull:`). ' +
          'Fields are columns (`txn_date`), qbXML aliases (`TxnDate`, `FullName`) or data paths (`CustomerRef.ListID`). ' +
          '`sort=name,-txn_date`; `q` is a prefix full-text search.',
        params: TypeParams,
        querystring: ListQuery,
      },
    },
    async (req) => {
      const e = entityOr404(req.params.type);
      const q = req.query;
      const page = await queryObjects(deps.db, {
        type: e.name,
        q: q.q,
        sort: q.sort,
        page: q.page,
        pageSize: q.pageSize,
        includeInactive: q.includeInactive ?? false,
        includeDeleted: q.includeDeleted ?? false,
        filters: filterParams(q).map(([f, v]) => parseFilterParam(f, v)),
      });
      return {
        type: e.name,
        items: page.items.map(objectView),
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
      };
    },
  );

  r.get(
    '/objects/:type/:id',
    {
      config: { permission: readPerm },
      schema: {
        tags: ['objects'],
        summary: 'One object from the read model',
        params: IdParams,
        querystring: z.object({ includeDeleted: zFlag }),
      },
    },
    async (req) => {
      const e = entityOr404(req.params.type);
      const row = await getObject(deps.db, e.name, req.params.id, {
        includeDeleted: req.query.includeDeleted ?? false,
      });
      if (!row) throw notFound(`${e.name} ${req.params.id} not found`);
      return objectView(row);
    },
  );

  r.post(
    '/objects/:type',
    {
      config: { permission: writePerm, rateLimit: 'write' },
      schema: {
        tags: ['objects'],
        summary: 'Add: queue an XxxAddRq (202 {commandId}; ?wait=true waits for QuickBooks)',
        description:
          'Body: the Add object in qbXML element names, bare (`{"Name":"Acme"}`) or wrapped (`{"CustomerAdd":{...}}`). ' +
          'It is validated against the XSD; invalid bodies return 400 with the errors and are never queued.',
        params: TypeParams,
        querystring: WaitQuery,
        body: Body,
      },
    },
    async (req, reply) => {
      const e = entityOr404(req.params.type);
      if (!e.ops.add) throw unsupported(e, 'add');
      const command = await submitCommand(deps, req, {
        kind: 'add',
        rq: e.ops.add,
        body: req.body,
        objectType: e.name,
        payload: req.body as JsonValue,
        action: 'object.add',
      });
      return replyWithCommand(deps, reply, command, req.query.wait ?? false);
    },
  );

  r.patch(
    '/objects/:type/:id',
    {
      config: { permission: writePerm, rateLimit: 'write' },
      schema: {
        tags: ['objects'],
        summary: 'Mod: queue an XxxModRq. The body must include EditSequence',
        params: IdParams,
        querystring: WaitQuery,
        body: Body,
      },
    },
    async (req, reply) => {
      const e = entityOr404(req.params.type);
      if (!e.ops.mod) throw unsupported(e, 'mod');
      const idField = requireIdEntity(e, 'mod');
      const el = catalog.requests[e.ops.mod]?.bodyElement;
      if (!el) throw unsupported(e, 'mod');
      const body = req.body;
      const wrapped = isRecord(body[el]);
      const inner: Record<string, unknown> = wrapped ? { ...(body[el] as object) } : { ...body };
      const rest: Record<string, unknown> = {};
      if (wrapped) for (const [k, v] of Object.entries(body)) if (k !== el) rest[k] = v;
      if (typeof inner.EditSequence !== 'string' || inner.EditSequence === '') {
        throw badRequest(
          'edit_sequence_required',
          'EditSequence is required for a Mod (take it from the object you are editing)',
        );
      }
      if (inner[idField] !== undefined && inner[idField] !== req.params.id) {
        throw badRequest('id_mismatch', `${idField} in the body does not match the URL`);
      }
      inner[idField] = req.params.id;
      const command = await submitCommand(deps, req, {
        kind: 'mod',
        rq: e.ops.mod,
        body: { [el]: inner, ...rest },
        objectType: e.name,
        objectId: req.params.id,
        payload: body as JsonValue,
        action: 'object.mod',
      });
      return replyWithCommand(deps, reply, command, req.query.wait ?? false);
    },
  );

  r.delete(
    '/objects/:type/:id',
    {
      config: { permission: writePerm, rateLimit: 'write' },
      schema: {
        tags: ['objects'],
        summary: 'Delete: queue a ListDelRq/TxnDelRq',
        params: IdParams,
        querystring: WaitQuery,
      },
    },
    async (req, reply) => {
      const e = entityOr404(req.params.type);
      if (!e.ops.del || !e.delType) throw unsupported(e, 'del');
      const idField = requireIdEntity(e, 'del');
      const typeField =
        catalog.objects[e.ops.del]?.fields.find((f) => f.name.endsWith('DelType'))?.name ??
        (idField === 'ListID' ? 'ListDelType' : 'TxnDelType');
      const command = await submitCommand(deps, req, {
        kind: 'del',
        rq: e.ops.del,
        body: { [typeField]: e.delType, [idField]: req.params.id },
        objectType: e.name,
        objectId: req.params.id,
        action: 'object.del',
      });
      return replyWithCommand(deps, reply, command, req.query.wait ?? false);
    },
  );

  r.post(
    '/objects/:type/:id/void',
    {
      config: { permission: writePerm, rateLimit: 'write' },
      schema: {
        tags: ['objects'],
        summary: 'Void a transaction: queue a TxnVoidRq',
        params: IdParams,
        querystring: WaitQuery,
      },
    },
    async (req, reply) => {
      const e = entityOr404(req.params.type);
      if (!e.ops.void || !e.voidType) throw unsupported(e, 'void');
      const idField = requireIdEntity(e, 'void');
      const command = await submitCommand(deps, req, {
        kind: 'void',
        rq: e.ops.void,
        body: { TxnVoidType: e.voidType, [idField]: req.params.id },
        objectType: e.name,
        objectId: req.params.id,
        action: 'object.void',
      });
      return replyWithCommand(deps, reply, command, req.query.wait ?? false);
    },
  );
}
