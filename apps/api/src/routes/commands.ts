import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  COMMAND_KINDS,
  COMMAND_STATUSES,
  getCommand,
  listCommands,
  type CommandKind,
  type CommandRow,
  type CommandStatus,
} from '@qbv/db';
import { typed, type RouteContext } from '../context.js';
import { can, requirePrincipal } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { zFlag } from '../lib/query.js';
import { commandView } from '../lib/views.js';
import { z } from '../lib/zod.js';

const csv = <T extends string>(values: readonly T[]) =>
  z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values as unknown as [T, ...T[]])))
    .optional();

const ListQuery = z.object({
  status: csv<CommandStatus>(COMMAND_STATUSES),
  kind: csv<CommandKind>(COMMAND_KINDS),
  objectType: z.string().max(100).optional(),
  objectId: z.string().max(100).optional(),
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  /** Only the caller's own commands, even with command:read. */
  mine: zFlag,
});

/** Callers see their own commands; `command:read` sees everyone's. */
export function canSeeCommand(req: FastifyRequest, c: CommandRow): boolean {
  const p = requirePrincipal(req);
  if (c.actor_type === p.type && c.actor_id === p.id) return true;
  return can(req, 'command:read');
}

export async function commandRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const r = typed(app);
  const { deps } = ctx;

  r.get(
    '/commands',
    {
      config: { authenticated: true },
      schema: {
        tags: ['commands'],
        summary: 'Command history, newest first (own commands unless command:read)',
        querystring: ListQuery,
      },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const q = req.query;
      const all = can(req, 'command:read') && !q.mine;
      const limit = q.limit ?? 50;
      const rows = await listCommands(deps.db, {
        status: q.status,
        kind: q.kind,
        objectType: q.objectType,
        objectId: q.objectId,
        before: q.before,
        limit,
        ...(all ? {} : { actorType: p.type, actorId: p.id }),
      });
      const last = rows[rows.length - 1];
      return {
        items: rows.map((c) => commandView(c)),
        nextBefore: rows.length === limit && last ? last.id : null,
      };
    },
  );

  r.get(
    '/commands/:id',
    {
      config: { authenticated: true },
      schema: {
        tags: ['commands'],
        summary: 'One command, including its request and response qbXML',
        params: z.object({ id: z.string().max(100) }),
      },
    },
    async (req) => {
      const c = await getCommand(deps.db, req.params.id);
      // Same 404 for "missing" and "not yours", so ids cannot be probed.
      if (!c || !canSeeCommand(req, c)) throw notFound(`Command ${req.params.id} not found`);
      return commandView(c, { detail: true });
    },
  );
}
