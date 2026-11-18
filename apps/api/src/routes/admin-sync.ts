import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { listSyncStates, writeAudit } from '@qbv/db';
import { catalog } from '@qbv/qbxml';
import { typed, type RouteContext } from '../context.js';
import { actorOf, clientIp, requirePrincipal } from '../lib/auth.js';
import { entityOr404 } from '../lib/meta.js';
import { badRequest } from '../lib/errors.js';
import { syncStateView } from '../lib/views.js';
import { z } from '../lib/zod.js';

export const SYNC_MODES = ['incremental', 'full', 'reconcile'] as const;

/**
 * Manual sync requests are RPUSHed as JSON onto `<QUEUE_PREFIX>:sync:requests`;
 * the sync service drains that list between units (apps/sync triggers.ts),
 * so a request survives while no sync instance is running.
 */
export function syncRequestsKey(prefix: string): string {
  return `${prefix}:sync:requests`;
}

/**
 * Why the sync service cannot load an entity, or null when it can. Mirrors
 * apps/sync planSync(): an entity needs a query (its own or a union query) that
 * has no required elements (subscription ids, an assembly, ...).
 */
export function unsyncableReason(name: string): string | null {
  const e = catalog.entities[name];
  if (!e) return 'unknown entity';
  const rq = e.ops.query ?? e.unionQuery;
  if (!rq) return 'no query request';
  const obj = catalog.objects[rq];
  if (!obj) return `query ${rq} is not in the catalog`;
  const required = obj.fields.filter((f) => f.minOccurs > 0).map((f) => f.name);
  return required.length ? `${rq} requires ${required.join(', ')}` : null;
}

export function syncableEntities(): string[] {
  return Object.values(catalog.entities)
    .filter((e) => unsyncableReason(e.name) === null)
    .map((e) => e.name)
    .sort();
}

export function unsyncableEntities(): { entity: string; reason: string }[] {
  return Object.values(catalog.entities)
    .filter((e) => (e.ops.query ?? e.unionQuery) && unsyncableReason(e.name) !== null)
    .map((e) => ({ entity: e.name, reason: unsyncableReason(e.name)! }))
    .sort((a, b) => a.entity.localeCompare(b.entity));
}

export async function adminSyncRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const r = typed(app);
  const { deps } = ctx;

  r.get(
    '/admin/sync',
    {
      config: { permission: 'admin' },
      schema: { tags: ['admin'], summary: 'Sync status per entity and pending manual requests' },
    },
    async () => {
      const states = await listSyncStates(deps.db);
      const key = syncRequestsKey(deps.config.QUEUE_PREFIX);
      const pending = await deps.redis.lrange(key, 0, 99);
      return {
        states: states.map(syncStateView),
        entities: syncableEntities(),
        unsyncable: unsyncableEntities(),
        pendingRequests: pending
          .map((s) => {
            try {
              return JSON.parse(s) as unknown;
            } catch {
              return null;
            }
          })
          .filter(Boolean),
      };
    },
  );

  r.post(
    '/admin/sync/:type',
    {
      config: { permission: 'admin', rateLimit: 'write' },
      schema: {
        tags: ['admin'],
        summary: 'Ask the sync service to sync one entity (or `*` for all) now',
        params: z.object({ type: z.string().min(1).max(100) }),
        body: z.object({ mode: z.enum(SYNC_MODES).optional() }).nullish(),
      },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const type = req.params.type;
      if (type !== '*') {
        const e = entityOr404(type);
        const reason = unsyncableReason(e.name);
        if (reason) {
          throw badRequest('not_syncable', `${e.name} cannot be synced: ${reason}`);
        }
      }
      const request = {
        id: randomUUID(),
        type,
        mode: req.body?.mode ?? 'incremental',
        requestedBy: `${p.type}:${p.id}`,
        requestedAt: new Date().toISOString(),
      };
      await deps.redis.rpush(syncRequestsKey(deps.config.QUEUE_PREFIX), JSON.stringify(request));
      await writeAudit(deps.db, {
        ...actorOf(p),
        action: 'admin.sync.trigger',
        objectType: type,
        ip: clientIp(req),
        detail: { mode: request.mode, requestId: request.id },
      });
      return reply.code(202).send({ request });
    },
  );
}
