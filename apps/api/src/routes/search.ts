import type { FastifyInstance } from 'fastify';
import { hasPermission, searchObjects, SEARCH_MAX_PER_TYPE } from '@qbv/db';
import { typed, type RouteContext } from '../context.js';
import { requirePrincipal } from '../lib/auth.js';
import { listEntities } from '../lib/meta.js';
import { zFlag } from '../lib/query.js';
import { z } from '../lib/zod.js';

const SearchQuery = z.object({
  q: z.string().max(200).optional(),
  /** Comma-separated entity types to return hits for. */
  types: z.string().max(2000).optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  /** Customer/vendor/employee/other-name ListID. */
  entity: z.string().max(100).optional(),
  amountMin: z.string().max(30).optional(),
  amountMax: z.string().max(30).optional(),
  includeInactive: zFlag,
  perType: z.coerce.number().int().min(1).max(SEARCH_MAX_PER_TYPE).optional(),
});

/** Entity types that live in the read model, by category. */
const SEARCHABLE = listEntities().filter((e) => e.syncable);
const CATEGORY = new Map(SEARCHABLE.map((e) => [e.name, e.category]));

export async function searchRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const r = typed(app);

  r.get(
    '/search',
    {
      config: { authenticated: true },
      schema: {
        tags: ['objects'],
        summary: 'Search every record type the caller can read, grouped by type',
        description:
          '`q` is a prefix full-text search. Filters: `from`/`to` (transaction date, YYYY-MM-DD), ' +
          '`entity` (a customer/vendor ListID; a customer includes its jobs), `amountMin`/`amountMax`, ' +
          '`includeInactive`. `types=Invoice,Bill` limits hits to those types; every group still reports its `total` ' +
          'so the UI can show counts for all types. Requires `q` or at least one filter.',
        querystring: SearchQuery,
      },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const q = req.query;
      const allowed = SEARCHABLE.map((e) => e.name).filter((t) =>
        hasPermission(p.permissions, `object:${t}:read`),
      );
      const types = q.types
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await searchObjects(ctx.deps.db, {
        q: q.q,
        allowedTypes: allowed,
        types,
        dateFrom: q.from || undefined,
        dateTo: q.to || undefined,
        entityId: q.entity || undefined,
        amountMin: q.amountMin || undefined,
        amountMax: q.amountMax || undefined,
        includeInactive: q.includeInactive ?? false,
        perType: q.perType,
      });
      return {
        groups: res.groups.map((g) => ({ ...g, category: CATEGORY.get(g.type) ?? 'other' })),
      };
    },
  );
}
