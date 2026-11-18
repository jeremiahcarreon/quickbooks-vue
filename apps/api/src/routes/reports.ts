import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type RouteContext } from '../context.js';
import { actorOf, authorize, requirePrincipal } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';

export const REPORTS_PREFIX = '/reports';

/**
 * What registerReportRoutes(app, deps) receives (@qbv/reports ReportRouteDeps):
 * the database, relay queue and event bus, the report cache TTL, and how to
 * read the caller's permissions and actor from the request.
 */
export function reportDeps(ctx: RouteContext) {
  const { deps } = ctx;
  return {
    db: deps.db,
    queue: deps.queue,
    events: deps.events,
    cacheTtlMs: deps.config.REPORT_CACHE_TTL,
    maxWaitMs: deps.config.COMMAND_WAIT_TIMEOUT,
    getPermissions: (req: FastifyRequest) => req.principal?.permissions ?? null,
    getActor: (req: FastifyRequest) => (req.principal ? actorOf(req.principal) : undefined),
  };
}
export type ReportRouteDeps = ReturnType<typeof reportDeps>;

type RegisterFn = (app: FastifyInstance, deps: ReportRouteDeps) => unknown;

/** Load @qbv/reports if it is installed and built; undefined otherwise. */
export async function loadReportsModule(log?: {
  warn: (o: object, m: string) => void;
}): Promise<RegisterFn | undefined> {
  const spec = '@qbv/reports';
  try {
    const mod = (await import(spec)) as { registerReportRoutes?: RegisterFn };
    if (typeof mod.registerReportRoutes === 'function') return mod.registerReportRoutes;
    log?.warn({}, '@qbv/reports does not export registerReportRoutes; reports disabled');
  } catch (err) {
    log?.warn({ err: (err as Error).message }, '@qbv/reports not available; reports disabled');
  }
  return undefined;
}

/**
 * Every report route requires a logged-in caller; `/reports/:name` (and
 * anything under it) also requires `report:<name>`. Enforced here so it holds
 * whatever the reports package registers.
 */
function reportGuard(req: FastifyRequest): void {
  requirePrincipal(req);
  const name = (req.params as { name?: unknown } | undefined)?.name;
  if (typeof name === 'string' && name) authorize(req, `report:${name}`);
}

export async function reportRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  register: RegisterFn | undefined,
): Promise<'mounted' | 'unavailable'> {
  app.addHook('onRequest', async (req) => reportGuard(req));
  if (register) {
    await register(app, reportDeps(ctx));
    return 'mounted';
  }
  const unavailable = async () => {
    throw new HttpError(501, 'not_implemented', 'Reports are not available in this build');
  };
  app.get(
    `${REPORTS_PREFIX}`,
    { schema: { tags: ['reports'], summary: 'Report list (501: reports not installed)' } },
    unavailable,
  );
  app.get(
    `${REPORTS_PREFIX}/:name`,
    { schema: { tags: ['reports'], summary: 'Run a report (501: reports not installed)' } },
    unavailable,
  );
  return 'unavailable';
}
