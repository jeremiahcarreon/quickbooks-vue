import type { FastifyInstance } from 'fastify';
import { catalog } from '@qbv/qbxml';
import { typed, type RouteContext } from '../context.js';
import { can } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import {
  entityDetail,
  entityOr404,
  listEntities,
  listRequests,
  objectClosure,
} from '../lib/meta.js';
import { z } from '../lib/zod.js';

export async function metaRoutes(app: FastifyInstance, _ctx: RouteContext): Promise<void> {
  const r = typed(app);

  r.get(
    '/meta/entities',
    {
      config: { authenticated: true },
      schema: {
        tags: ['meta'],
        summary: 'Every entity in the qbXML catalog, with ops and the caller’s access',
      },
    },
    async (req) => ({
      version: catalog.version,
      entities: listEntities().map((e) => ({
        ...e,
        access: {
          read: can(req, `object:${e.name}:read`),
          write: can(req, `object:${e.name}:write`),
        },
      })),
    }),
  );

  r.get(
    '/meta/entities/:type',
    {
      config: { authenticated: true },
      schema: {
        tags: ['meta'],
        summary:
          'One entity: request definitions and every object (fields in schema order, types, lengths, enums, refs)',
        params: z.object({ type: z.string().min(1).max(100) }),
      },
    },
    async (req) => {
      const e = entityOr404(req.params.type);
      const d = entityDetail(e);
      return {
        ...d,
        entity: {
          ...d.entity,
          access: {
            read: can(req, `object:${e.name}:read`),
            write: can(req, `object:${e.name}:write`),
          },
        },
      };
    },
  );

  r.get(
    '/meta/requests',
    {
      config: { authenticated: true },
      schema: { tags: ['meta'], summary: 'Every qbXML request type (for the qbXML console)' },
    },
    async () => ({ version: catalog.version, requests: listRequests() }),
  );

  r.get(
    '/meta/objects/:name',
    {
      config: { authenticated: true },
      schema: {
        tags: ['meta'],
        summary: 'One catalog object (e.g. InvoiceAddRq, CustomerRet) and the objects it uses',
        params: z.object({ name: z.string().min(1).max(100) }),
      },
    },
    async (req) => {
      const name = req.params.name;
      if (!catalog.objects[name])
        throw notFound(`Unknown qbXML object "${name}"`, 'unknown_object');
      return {
        root: name,
        request: catalog.requests[name] ?? null,
        objects: objectClosure([name]),
      };
    },
  );
}
