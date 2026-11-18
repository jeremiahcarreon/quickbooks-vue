import { sql } from 'kysely';
import {
  getCommand,
  getReportCache,
  putReportCache,
  reportCacheKey,
  type ActorType,
  type CommandRow,
  type Db,
  type JsonValue,
} from '@qbv/db';
import {
  enqueueCommand,
  Priority,
  waitForCommand,
  type EventBus,
  type RelayQueue,
} from '@qbv/queue';
import { todayIso } from '../dates.js';
import { ReportError } from '../params.js';
import type { ReportParams, ReportResult } from '../types.js';
import { buildQbReportRequest, type QbReportDefinition } from './definitions.js';
import { parseQbReportResponse } from './parse.js';

export const DEFAULT_REPORT_CACHE_TTL_MS = 15 * 60_000;
export const DEFAULT_REPORT_WAIT_MS = 20_000;

export interface QbReportDeps {
  db: Db;
  /** Relay queue; QB reports answer 503 without it. */
  queue?: RelayQueue;
  events?: EventBus;
  /** report_cache TTL (REPORT_CACHE_TTL), default 15 minutes. */
  cacheTtlMs?: number;
  /** How long a request waits for QuickBooks before answering "pending", default 20s. */
  waitMs?: number;
  now?: () => Date;
}

export interface RunQbOptions {
  /** Ignore the cache and fetch again from QuickBooks. */
  refresh?: boolean;
  /** Continue waiting on a command returned by an earlier "pending" answer. */
  commandId?: string;
  waitMs?: number;
  actorType?: ActorType;
  actorId?: string | null;
}

export type ReportOutcome =
  | { status: 'ready'; result: ReportResult }
  | { status: 'pending'; commandId: string; commandStatus: string };

/** Params that make up the cache key; relative dates also key on the current day. */
export function qbCacheKey(def: QbReportDefinition, params: ReportParams, today: string): string {
  const keyParams: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined) keyParams[k] = v as JsonValue;
  if (!(params.from && params.to)) keyParams._day = today;
  return reportCacheKey(def.name, keyParams);
}

async function findReportCommand(
  db: Db,
  key: string,
  since: Date,
  statuses: string[],
): Promise<CommandRow | undefined> {
  return db
    .selectFrom('command')
    .selectAll()
    .where('kind', '=', 'report')
    .where(sql<string>`payload->>'cacheKey'`, '=', key)
    .where('created_at', '>', since)
    .where('status', 'in', statuses as CommandRow['status'][])
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
}

function commandError(cmd: CommandRow): ReportError {
  if (cmd.status === 'rejected') {
    return new ReportError(
      500,
      'qbxml_rejected',
      cmd.status_message ?? 'Report request was rejected',
      {
        commandId: cmd.id,
      },
    );
  }
  return new ReportError(
    502,
    'qb_error',
    `QuickBooks could not run the report: ${cmd.status_message ?? cmd.status}`,
    { commandId: cmd.id, statusCode: cmd.status_code, statusMessage: cmd.status_message },
  );
}

/**
 * Run a QuickBooks report: serve it from report_cache when fresh, otherwise
 * build and validate the request (via @qbv/qbxml), enqueue it at report
 * priority and wait up to `waitMs` for the worker. Identical concurrent
 * requests share one relay command.
 */
export async function runQbReport(
  deps: QbReportDeps,
  def: QbReportDefinition,
  params: ReportParams,
  opts: RunQbOptions = {},
): Promise<ReportOutcome> {
  const now = deps.now?.() ?? new Date();
  const today = todayIso(now);
  const ttlMs = deps.cacheTtlMs ?? DEFAULT_REPORT_CACHE_TTL_MS;
  const key = qbCacheKey(def, params, today);
  const baseMeta = {
    name: def.name,
    title: def.title,
    source: 'qb' as const,
    params: params as Record<string, unknown>,
    generatedAt: now.toISOString(),
  };

  const finalize = async (cmd: CommandRow): Promise<ReportOutcome> => {
    if (cmd.status !== 'succeeded') throw commandError(cmd);
    if (!cmd.response_xml) {
      throw new ReportError(502, 'qb_bad_response', 'The report command has no response', {
        commandId: cmd.id,
      });
    }
    const fetchedAt = cmd.finished_at ?? now;
    const result = parseQbReportResponse(cmd.response_xml, { ...baseMeta, commandId: cmd.id });
    result.meta.fetchedAt = fetchedAt.toISOString();
    result.meta.expiresAt = new Date(fetchedAt.getTime() + ttlMs).toISOString();
    result.meta.cached = false;
    await putReportCache(deps.db, {
      key,
      report: def.name,
      params: baseMeta.params as JsonValue,
      result: result as unknown as JsonValue,
      ttlMs,
      fetchedAt,
    });
    return { status: 'ready', result };
  };

  const wait = async (cmd: CommandRow): Promise<ReportOutcome> => {
    if (cmd.status === 'queued' || cmd.status === 'sending') {
      const w = await waitForCommand(deps.db, cmd.id, {
        events: deps.events,
        timeoutMs: opts.waitMs ?? deps.waitMs ?? DEFAULT_REPORT_WAIT_MS,
      });
      if (!w.done || !w.command) {
        return {
          status: 'pending',
          commandId: cmd.id,
          commandStatus: w.command?.status ?? cmd.status,
        };
      }
      return finalize(w.command);
    }
    return finalize(cmd);
  };

  if (opts.commandId) {
    const cmd = await getCommand(deps.db, opts.commandId);
    const payload = (cmd?.payload ?? {}) as Record<string, unknown>;
    if (!cmd || cmd.kind !== 'report' || payload.report !== def.name) {
      throw new ReportError(404, 'not_found', 'No such report command for this report');
    }
    if (cmd.status === 'succeeded' && payload.cacheKey === key) {
      const hit = await getReportCache(deps.db, key, { now });
      if (hit) return cachedOutcome(hit.result, hit.fetched_at, hit.expires_at);
    }
    return wait(cmd);
  }

  if (!opts.refresh) {
    const hit = await getReportCache(deps.db, key, { now });
    if (hit) return cachedOutcome(hit.result, hit.fetched_at, hit.expires_at);
  }

  const since = new Date(now.getTime() - ttlMs);
  const existing = await findReportCommand(
    deps.db,
    key,
    since,
    opts.refresh ? ['queued', 'sending'] : ['queued', 'sending', 'succeeded'],
  );
  if (existing) return wait(existing);

  if (!deps.queue) {
    throw new ReportError(
      503,
      'queue_unavailable',
      'QuickBooks reports are not available: no relay queue',
    );
  }
  const { xml } = buildQbReportRequest(def, params, { today });
  const { command } = await enqueueCommand(
    deps.db,
    deps.queue,
    {
      kind: 'report',
      rqName: def.qb.request,
      objectType: null,
      payload: { report: def.name, params: baseMeta.params as JsonValue, cacheKey: key },
      requestXml: xml,
      priority: Priority.ReportFetch,
      actorType: opts.actorType ?? 'system',
      actorId: opts.actorId ?? null,
    },
    { events: deps.events },
  );
  return wait(command);
}

function cachedOutcome(stored: JsonValue, fetchedAt: Date, expiresAt: Date): ReportOutcome {
  const result = structuredClone(stored) as unknown as ReportResult;
  result.meta = {
    ...result.meta,
    cached: true,
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  return { status: 'ready', result };
}
