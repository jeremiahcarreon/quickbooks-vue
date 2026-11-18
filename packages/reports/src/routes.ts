import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { hasPermission, type ActorType } from '@qbv/db';
import { QbxmlValidationError } from '@qbv/qbxml';
import { QbxmlRejectedError } from '@qbv/queue';
import { reportToCsv } from './csv.js';
import { ReportError } from './params.js';
import {
  describeReport,
  getReport,
  listReports,
  reportPermission,
  runReport,
  type ReportDeps,
} from './registry.js';

export interface ReportActor {
  actorType: ActorType;
  actorId: string | null;
}

export interface ReportRouteDeps extends ReportDeps {
  /**
   * Permissions of the caller. Default: `request.auth.permissions`,
   * `request.user.permissions` or `request.permissions`, whichever the auth
   * layer set. Return null/undefined for an unauthenticated request (401).
   */
  getPermissions?: (
    request: FastifyRequest,
  ) => readonly string[] | null | undefined | Promise<readonly string[] | null | undefined>;
  /** Who is asking, recorded on the relay command. Default: derived from request.auth/user. */
  getActor?: (request: FastifyRequest) => ReportActor | undefined;
  /** Upper bound for the `wait` query parameter in ms (default 60s). */
  maxWaitMs?: number;
}

/** Reserved query parameters; everything else is a report parameter. */
const RESERVED = new Set(['refresh', 'commandId', 'wait', 'format']);

type AnyRecord = Record<string, unknown>;

function defaultPermissions(req: FastifyRequest): readonly string[] | undefined {
  const r = req as unknown as AnyRecord;
  for (const holder of [r.auth, r.user]) {
    const p = (holder as AnyRecord | undefined)?.permissions;
    if (Array.isArray(p)) return p as string[];
  }
  return Array.isArray(r.permissions) ? (r.permissions as string[]) : undefined;
}

function defaultActor(req: FastifyRequest): ReportActor | undefined {
  const r = req as unknown as AnyRecord;
  const auth = (r.auth ?? r.user) as AnyRecord | undefined;
  if (!auth) return undefined;
  const type = auth.actorType ?? auth.type ?? (auth.tokenId ? 'token' : 'user');
  const id = auth.actorId ?? auth.userId ?? auth.tokenId ?? auth.id ?? null;
  return {
    actorType: type === 'token' || type === 'system' ? type : 'user',
    actorId: typeof id === 'string' ? id : null,
  };
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return reply
    .code(status)
    .send({ error: details === undefined ? { code, message } : { code, message, details } });
}

const truthy = (v: unknown) =>
  typeof v === 'string' && ['1', 'true', 'yes'].includes(v.toLowerCase());

/**
 * GET /reports            catalog of reports the caller may run
 * GET /reports/:name      run one report (JSON, or CSV with ?format=csv)
 *
 * Report params come from the query string. Reserved: `refresh=true`
 * (bypass the QB report cache), `commandId` (continue a pending QB report),
 * `wait` (ms to wait for QuickBooks), `format=json|csv`. QB reports answer
 * 202 `{ status: 'pending', commandId }` when QuickBooks has not answered in
 * time; call again with that commandId.
 */
export async function registerReportRoutes(
  app: FastifyInstance,
  deps: ReportRouteDeps,
): Promise<void> {
  const permissionsOf = async (req: FastifyRequest) =>
    (await (deps.getPermissions ?? defaultPermissions)(req)) ?? null;
  const maxWait = deps.maxWaitMs ?? 60_000;

  app.get('/reports', async (req, reply) => {
    const perms = await permissionsOf(req);
    if (!perms) return sendError(reply, 401, 'unauthorized', 'Sign in required');
    const reports = listReports()
      .filter((d) => hasPermission(perms, reportPermission(d.name)))
      .map(describeReport);
    const categories = [...new Set(reports.map((r) => r.category))].sort();
    return reply.send({ reports, categories });
  });

  app.get<{ Params: { name: string }; Querystring: Record<string, string | string[]> }>(
    '/reports/:name',
    async (req, reply) => {
      const perms = await permissionsOf(req);
      if (!perms) return sendError(reply, 401, 'unauthorized', 'Sign in required');
      const { name } = req.params;
      const def = getReport(name);
      if (!def) return sendError(reply, 404, 'not_found', `Unknown report ${name}`);
      if (!hasPermission(perms, reportPermission(name))) {
        return sendError(reply, 403, 'forbidden', `Missing permission ${reportPermission(name)}`);
      }
      const q = (req.query ?? {}) as Record<string, string | string[]>;
      const one = (k: string): string | undefined => {
        const v = q[k];
        return Array.isArray(v) ? v[v.length - 1] : v;
      };
      const raw: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(q)) if (!RESERVED.has(k)) raw[k] = v;
      const waitRaw = one('wait');
      const waitMs =
        waitRaw !== undefined && /^\d+$/.test(waitRaw)
          ? Math.min(Number(waitRaw), maxWait)
          : undefined;
      const format = one('format') ?? 'json';
      if (format !== 'json' && format !== 'csv') {
        return sendError(reply, 400, 'invalid_params', 'format must be json or csv');
      }
      const actor = (deps.getActor ?? defaultActor)(req);
      try {
        const outcome = await runReport(deps, name, raw, {
          refresh: truthy(one('refresh')),
          commandId: one('commandId'),
          waitMs,
          actorType: actor?.actorType ?? 'system',
          actorId: actor?.actorId ?? null,
        });
        if (outcome.status === 'pending') {
          return reply.code(202).header('Retry-After', '2').send({
            status: 'pending',
            commandId: outcome.commandId,
            commandStatus: outcome.commandStatus,
          });
        }
        if (format === 'csv') {
          return reply
            .header('Content-Type', 'text/csv; charset=utf-8')
            .header(
              'Content-Disposition',
              `attachment; filename="${name.replace(/[^\w.-]/g, '_')}.csv"`,
            )
            .send(reportToCsv(outcome.result));
        }
        return reply.send({ status: 'ready', ...outcome.result });
      } catch (err) {
        if (err instanceof ReportError)
          return sendError(reply, err.status, err.code, err.message, err.details);
        if (err instanceof QbxmlValidationError || err instanceof QbxmlRejectedError) {
          req.log.error({ err, report: name }, 'report request failed XSD validation');
          return sendError(
            reply,
            500,
            'qbxml_invalid',
            'The report request failed XSD validation',
            {
              errors: err.errors,
            },
          );
        }
        throw err;
      }
    },
  );
}

/** The same routes as an encapsulated Fastify plugin: `app.register(reportRoutes, deps)`. */
export const reportRoutes: FastifyPluginAsync<ReportRouteDeps> = async (app, opts) => {
  await registerReportRoutes(app, opts);
};
