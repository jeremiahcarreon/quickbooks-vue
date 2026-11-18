import { getRequest, parseResponse, type ParsedRs } from '@qbv/qbxml';
import { updateCommand, type CommandRow, type Db, type JsonValue } from '@qbv/db';
import { enqueueCommand, waitForCommand, type EventBus, type RelayQueue } from '@qbv/queue';
import type { BuiltQuery } from './queries.js';

export type SyncPhase = 'initial' | 'incremental' | 'deleted' | 'reconcile' | 'fetch' | 'full';

export interface RunQueryInput {
  query: BuiltQuery;
  priority: number;
  /** Entity or unit the query is for (command.object_type). */
  objectType: string;
  phase: SyncPhase;
  signal?: AbortSignal;
}

export interface QueryResult {
  rs: ParsedRs;
  commandId?: string;
}

/** Sends one sync query and returns QuickBooks' parsed response. */
export interface QueryRunner {
  run(input: RunQueryInput): Promise<QueryResult>;
}

export class SyncCommandError extends Error {
  readonly commandId: string | undefined;
  readonly status: string | undefined;
  readonly statusCode: number | null | undefined;
  constructor(
    message: string,
    info: { commandId?: string; status?: string; statusCode?: number | null } = {},
  ) {
    super(message);
    this.name = 'SyncCommandError';
    this.commandId = info.commandId;
    this.status = info.status;
    this.statusCode = info.statusCode;
  }
}

export class SyncAbortedError extends Error {
  constructor() {
    super('Sync run aborted');
    this.name = 'SyncAbortedError';
  }
}

/** Pick the response element that answers `rq` from a parsed document. */
export function responseFor(rq: string, xml: string): ParsedRs {
  const all = parseResponse(xml);
  const want = getRequest(rq).response;
  const rs = all.find((r) => r.name === want) ?? all[0];
  if (!rs) throw new SyncCommandError(`Response to ${rq} has no response element`);
  return rs;
}

export interface QueueQueryRunnerOptions {
  events?: EventBus;
  /** How long to wait for one command (queued behind other work included). */
  timeoutMs?: number;
  /** Drop response_xml from finished sync commands once processed (keeps the command table small). */
  pruneResponses?: boolean;
  actorId?: string;
}

/**
 * Runs queries as `query` commands on the relay queue: the worker is the only
 * process that talks to the relay. enqueueCommand validates the XML against
 * the XSD again before anything is stored.
 */
export class QueueQueryRunner implements QueryRunner {
  constructor(
    private readonly db: Db,
    private readonly queue: RelayQueue,
    private readonly opts: QueueQueryRunnerOptions = {},
  ) {}

  async run(input: RunQueryInput): Promise<QueryResult> {
    if (input.signal?.aborted) throw new SyncAbortedError();
    const { query } = input;
    const payload: JsonValue = {
      sync: { phase: input.phase, unit: input.objectType },
      // Sync stores the Rets itself (reconcile asks for id-only Rets that must
      // never overwrite full rows), so the worker should not write them through.
      writeThrough: false,
      body: JSON.parse(JSON.stringify(query.body)) as JsonValue,
      ...(query.iterator ? { iterator: query.iterator } : {}),
    };
    const { command } = await enqueueCommand(
      this.db,
      this.queue,
      {
        kind: 'query',
        rqName: query.rq,
        objectType: input.objectType,
        payload,
        requestXml: query.xml,
        priority: input.priority,
        actorType: 'system',
        actorId: this.opts.actorId ?? 'sync',
      },
      { events: this.opts.events },
    );
    const waited = await waitForCommand(this.db, command.id, {
      events: this.opts.events,
      timeoutMs: this.opts.timeoutMs ?? 30 * 60_000,
      signal: input.signal,
    });
    if (input.signal?.aborted) throw new SyncAbortedError();
    if (!waited.done || !waited.command) {
      throw new SyncCommandError(
        `${query.rq} command ${command.id} did not finish in time (status ${waited.command?.status ?? 'unknown'})`,
        { commandId: command.id, status: waited.command?.status },
      );
    }
    const rs = this.toResult(waited.command);
    if (this.opts.pruneResponses !== false) {
      await updateCommand(this.db, command.id, {
        responseXml: null,
        result: {
          pruned: true,
          statusCode: rs.statusCode,
          retCount: rs.rets.length,
          iteratorRemainingCount: rs.iteratorRemainingCount ?? null,
        },
      }).catch(() => undefined);
    }
    return { rs, commandId: command.id };
  }

  private toResult(cmd: CommandRow): ParsedRs {
    const rq = cmd.rq_name ?? '';
    if (cmd.response_xml) {
      try {
        return responseFor(rq, cmd.response_xml);
      } catch (err) {
        throw new SyncCommandError(`Unreadable response to ${rq}: ${(err as Error).message}`, {
          commandId: cmd.id,
          status: cmd.status,
        });
      }
    }
    throw new SyncCommandError(
      `${rq} command ${cmd.id} ${cmd.status}` +
        (cmd.status_code !== null ? ` (${cmd.status_code})` : '') +
        (cmd.status_message ? `: ${cmd.status_message}` : ''),
      { commandId: cmd.id, status: cmd.status, statusCode: cmd.status_code },
    );
  }
}
