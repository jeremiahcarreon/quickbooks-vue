import {
  finishCommand,
  getCommand,
  isTerminalStatus,
  markCommandSending,
  markDeleted,
  updateCommand,
  upsertObjects,
  writeAudit,
  type CommandRow,
  type Db,
  type FinishCommandInput,
  type JsonValue,
  type Ret,
} from '@qbv/db';
import {
  buildRequest,
  entityOfRet,
  isOk,
  parseResponse,
  validate as xsdValidate,
  type EntityDef,
  type ParsedRs,
} from '@qbv/qbxml';
import type { ObjectChangedEvent } from '@qbv/queue';
import { RelayError, RelayValidationError } from '@qbv/relay-client';
import { entityOfDelOrVoidRs, entityOfRq, targetIdOfRq } from './entities.js';
import { LookupError, QbLookup } from './lookup.js';
import { describeRequest, textOf, type RequestInfo, type RqInfo } from './request-info.js';
import {
  silentLogger,
  type EventPublisher,
  type Logger,
  type RelayLike,
  type Validator,
} from './types.js';
import { verifyInterrupted, type AppliedChange } from './verify.js';

/** QuickBooks status code: the EditSequence in a Mod is out of date. */
export const EDIT_SEQUENCE_CONFLICT = 3200;

/** Command kinds that change QuickBooks data (raw counts when it holds a non-query request). */
const WRITE_KINDS = new Set(['add', 'mod', 'del', 'void']);

export interface CircuitHooks {
  recordSuccess(): Promise<void>;
  recordFailure(error: string): Promise<void>;
}

export interface ProcessorOptions {
  db: Db;
  relay: RelayLike;
  events?: EventPublisher;
  log?: Logger;
  /** XSD validator; defaults to @qbv/qbxml `validate` (libxml2 against the 17.0 XSD). */
  validator?: Validator;
  /** `<?qbxml version?>` for requests the worker builds itself (QBXML_VERSION). */
  qbxmlVersion?: string;
  circuit?: CircuitHooks;
  /**
   * Allowed clock difference between this server and the QuickBooks host when
   * matching TimeCreated during verification of an interrupted Add. Default 15 min.
   */
  clockSkewMs?: number;
}

/** Where this job is in its retry budget. `attemptsMade` counts earlier failed attempts. */
export interface AttemptInfo {
  attemptsMade: number;
  maxAttempts: number;
}

export interface ProcessResult {
  commandId: string;
  status: CommandRow['status'] | 'skipped';
  command?: CommandRow;
  reason?: string;
}

/**
 * Thrown for a transient relay failure (503, 504, network) when attempts are
 * left: the command is back to `queued` and the job should be retried with
 * backoff.
 */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly relayError: RelayError,
  ) {
    super(message, { cause: relayError });
    this.name = 'RetryLaterError';
  }
}

/** Marker stored in command.result while a retry is pending after a send that may have executed. */
interface PendingVerification {
  reason: string;
  at: string;
}

interface ChangedObject {
  objectType: string;
  qbId: string;
  op: ObjectChangedEvent['op'];
}

interface Finalize {
  status: FinishCommandInput['status'];
  statusCode?: number | null;
  statusMessage?: string | null;
  responseXml?: string | null;
  result?: Record<string, unknown> | null;
  objectId?: string | null;
  upserts?: { entity: EntityDef; rets: Ret[] }[];
  deletes?: { entity: EntityDef; ids: string[] }[];
  changed?: ChangedObject[];
  audit: boolean;
  rqNames?: string[];
}

const UNKNOWN_OUTCOME =
  'The earlier attempt may have reached QuickBooks and its outcome cannot be confirmed with a query, ' +
  'so it was not resent (resending could apply it twice). Check QuickBooks, then submit it again if it is missing.';

function pendingVerificationOf(cmd: CommandRow): PendingVerification | undefined {
  const r = cmd.result as Record<string, unknown> | null;
  const p = r && typeof r === 'object' ? r.pendingVerification : undefined;
  return p && typeof p === 'object' ? (p as PendingVerification) : undefined;
}

function isWriteRequest(kind: string, info: RequestInfo | undefined): boolean {
  if (WRITE_KINDS.has(kind)) return true;
  if (kind === 'raw') return info ? !info.readOnly : true;
  return false;
}

function formatErrors(errors: { line: number; message: string }[]): string {
  return errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)).join('; ');
}

/** Non-Ret content of a response element (ListDelRs, TxnVoidRs, ...), without attributes. */
function fieldsOf(rs: ParsedRs): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rs.body)) {
    if (k.startsWith('@') || k.endsWith('Ret')) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function summarize(rs: ParsedRs): Record<string, unknown> {
  const s: Record<string, unknown> = {
    name: rs.name,
    statusCode: rs.statusCode,
    statusSeverity: rs.statusSeverity,
    statusMessage: rs.statusMessage,
    retNames: rs.retNames,
    rets: rs.rets,
  };
  if (rs.requestID !== undefined) s.requestID = rs.requestID;
  if (rs.retCount !== undefined) s.retCount = rs.retCount;
  if (rs.iteratorID !== undefined) s.iteratorID = rs.iteratorID;
  if (rs.iteratorRemainingCount !== undefined) s.iteratorRemainingCount = rs.iteratorRemainingCount;
  const f = fieldsOf(rs);
  if (f) s.fields = f;
  return s;
}

/** Pair each request element with its response element (by requestID, else by position). */
export function pairResponses(
  info: RequestInfo,
  rss: ParsedRs[],
): { rq: RqInfo; rs: ParsedRs | undefined }[] {
  const byId = new Map<string, ParsedRs>();
  for (const rs of rss) if (rs.requestID !== undefined) byId.set(rs.requestID, rs);
  return info.rqs.map((rq) => {
    let rs = rq.requestID !== undefined ? byId.get(rq.requestID) : undefined;
    if (!rs) {
      const at = rss[rq.index];
      const expected = rq.def?.response ?? rq.name.replace(/Rq$/, 'Rs');
      if (at && at.name === expected && (at.requestID === undefined || rq.requestID === undefined))
        rs = at;
    }
    return { rq, rs };
  });
}

/**
 * Processes one command: validate, send through the relay, interpret
 * QuickBooks' answer, write through to the read model and finish the command
 * (DESIGN section 6.4). Independent of BullMQ so it can be tested directly.
 */
export class CommandProcessor {
  private readonly db: Db;
  private readonly relay: RelayLike;
  private readonly log: Logger;
  private readonly validator: Validator;
  private readonly lookup: QbLookup;
  private readonly skewMs: number;

  constructor(private readonly opts: ProcessorOptions) {
    this.db = opts.db;
    this.relay = opts.relay;
    this.log = opts.log ?? silentLogger;
    this.validator = opts.validator ?? xsdValidate;
    this.lookup = new QbLookup(opts.relay, opts.qbxmlVersion);
    this.skewMs = opts.clockSkewMs ?? 15 * 60_000;
  }

  async process(
    commandId: string,
    attempt: AttemptInfo = { attemptsMade: 0, maxAttempts: 1 },
  ): Promise<ProcessResult> {
    const cmd = await getCommand(this.db, commandId);
    if (!cmd) return { commandId, status: 'skipped', reason: 'command not found' };
    if (isTerminalStatus(cmd.status)) {
      return { commandId, status: 'skipped', command: cmd, reason: `already ${cmd.status}` };
    }
    const log = this.log;
    const pending = pendingVerificationOf(cmd);
    // 'sending' at pickup means an earlier attempt stopped mid-send (crash, stalled job).
    const interrupted = cmd.status === 'sending' || pending !== undefined;

    // 1. The request document (built from the payload if the producer stored none).
    let xml = cmd.request_xml;
    if (!xml) {
      if (!cmd.rq_name || !cmd.payload || typeof cmd.payload !== 'object') {
        return this.finalize(cmd, {
          status: 'rejected',
          statusMessage: 'Command has no request_xml and no rq_name/payload to build one from',
          audit: isWriteRequest(cmd.kind, undefined),
        });
      }
      try {
        xml = buildRequest(cmd.rq_name, cmd.payload as object, {
          version: this.opts.qbxmlVersion,
        });
      } catch (err) {
        const errors = (err as { errors?: { line: number; message: string }[] }).errors ?? [];
        return this.finalize(cmd, {
          status: 'rejected',
          statusMessage: `Cannot build ${cmd.rq_name}: ${(err as Error).message}`,
          result: { validationErrors: errors },
          audit: isWriteRequest(cmd.kind, undefined),
        });
      }
      await updateCommand(this.db, cmd.id, { requestXml: xml });
    }

    // 2. XSD validation. A document that fails is never sent.
    const v = this.validator(xml);
    if (!v.valid) {
      log.warn({ commandId, errors: v.errors }, 'command rejected: qbXML fails XSD validation');
      return this.finalize(cmd, {
        status: 'rejected',
        statusMessage: `qbXML failed XSD validation, not sent: ${formatErrors(v.errors)}`,
        result: { validationErrors: v.errors },
        audit: isWriteRequest(cmd.kind, undefined),
      });
    }
    let info: RequestInfo;
    try {
      info = describeRequest(xml);
    } catch (err) {
      return this.finalize(cmd, {
        status: 'rejected',
        statusMessage: (err as Error).message,
        audit: isWriteRequest(cmd.kind, undefined),
      });
    }
    const isWrite = isWriteRequest(cmd.kind, info);
    const rqNames = info.rqs.map((r) => r.name);

    // 3. An earlier attempt may have reached QuickBooks: check before resending a write.
    let verification: { resent: boolean; reason: string } | undefined;
    if (interrupted && !info.readOnly) {
      const since = new Date((cmd.started_at ?? cmd.created_at).getTime() - this.skewMs);
      let verdict;
      try {
        verdict = await verifyInterrupted(this.lookup, info, since);
      } catch (err) {
        if (err instanceof RelayError) {
          return this.relayFailure(cmd, err, attempt, isWrite, false, true);
        }
        if (!(err instanceof LookupError)) throw err;
        verdict = { action: 'unknown' as const, reason: err.message };
      }
      log.info(
        { commandId, verdict: verdict.action, reason: verdict.reason },
        'checked interrupted command',
      );
      if (verdict.action === 'unknown') {
        return this.finalize(cmd, {
          status: 'failed',
          statusMessage: `${UNKNOWN_OUTCOME} (${verdict.reason})`,
          result: { verification: { resent: false, outcome: 'unknown', reason: verdict.reason } },
          audit: isWrite,
          rqNames,
        });
      }
      if (verdict.action === 'applied')
        return this.finishApplied(cmd, verdict.applied, verdict.reason, rqNames);
      verification = { resent: true, reason: verdict.reason };
    }

    // 4. Claim and send.
    const claimed = await markCommandSending(this.db, cmd.id);
    if (!claimed) return { commandId, status: 'skipped', reason: 'command was finished elsewhere' };
    await this.publishCommand(claimed);
    let responseXml: string;
    try {
      responseXml = await this.relay.request(xml);
    } catch (err) {
      if (err instanceof RelayError) {
        return this.relayFailure(claimed, err, attempt, isWrite, true, interrupted);
      }
      throw err;
    }
    await this.opts.circuit?.recordSuccess();

    // 5. Interpret QuickBooks' answer.
    let rss: ParsedRs[];
    try {
      rss = parseResponse(responseXml);
    } catch (err) {
      return this.finalize(claimed, {
        status: 'failed',
        statusMessage: `Cannot parse the QuickBooks response: ${(err as Error).message}`,
        responseXml,
        audit: isWrite,
        rqNames,
      });
    }
    return this.complete(claimed, info, rss, responseXml, isWrite, verification);
  }

  /** Handle a relay failure: retry (transient, attempts left) or fail. */
  private async relayFailure(
    cmd: CommandRow,
    err: RelayError,
    attempt: AttemptInfo,
    isWrite: boolean,
    reachedRelay: boolean,
    alreadyUncertain: boolean,
  ): Promise<ProcessResult> {
    if (err instanceof RelayValidationError) {
      return this.finalize(cmd, {
        status: 'rejected',
        statusMessage: err.message,
        result: { validationErrors: err.errors },
        audit: isWrite,
      });
    }
    const mayHaveExecuted = reachedRelay && err.mayHaveExecuted;
    const uncertain = isWrite && (mayHaveExecuted || alreadyUncertain);
    const note = uncertain
      ? ' QuickBooks may have applied this change; check before submitting it again.'
      : '';
    if (err.retryable) {
      await this.opts.circuit?.recordFailure(err.message);
      const attemptNo = attempt.attemptsMade + 1;
      if (attemptNo < attempt.maxAttempts) {
        const prev = (cmd.result as Record<string, unknown> | null) ?? {};
        const result: Record<string, unknown> = { ...prev };
        if (uncertain) {
          result.pendingVerification = {
            reason: `${err.name}: ${err.message}`,
            at: new Date().toISOString(),
          } satisfies PendingVerification;
        }
        const row = await updateCommand(this.db, cmd.id, {
          status: 'queued',
          statusMessage: `Relay: ${err.message} (attempt ${attemptNo} of ${attempt.maxAttempts}, will retry)`,
          ...(uncertain ? { result: result as JsonValue } : {}),
        });
        if (row) await this.publishCommand(row);
        this.log.warn(
          { commandId: cmd.id, attempt: attemptNo, error: err.message, status: err.status },
          'relay unavailable, will retry',
        );
        throw new RetryLaterError(err.message, err);
      }
      return this.finalize(cmd, {
        status: 'failed',
        statusMessage: `Relay unavailable after ${attemptNo} attempts: ${err.message}.${note}`,
        result: {
          relayError: { name: err.name, status: err.status ?? null, message: err.message },
        },
        audit: isWrite,
      });
    }
    return this.finalize(cmd, {
      status: 'failed',
      statusMessage: `Relay error${err.status ? ` ${err.status}` : ''}: ${err.message}.${note}`,
      result: { relayError: { name: err.name, status: err.status ?? null, message: err.message } },
      audit: isWrite,
    });
  }

  /** The earlier, interrupted attempt was applied: record it without resending. */
  private async finishApplied(
    cmd: CommandRow,
    applied: AppliedChange[],
    reason: string,
    rqNames: string[],
  ): Promise<ProcessResult> {
    const upserts: Finalize['upserts'] = [];
    const deletes: Finalize['deletes'] = [];
    const changed: ChangedObject[] = [];
    for (const a of applied) {
      if (a.op === 'add' && a.ret) upserts.push({ entity: a.entity, rets: [a.ret] });
      if (a.op === 'del') deletes.push({ entity: a.entity, ids: [a.qbId] });
      changed.push({ objectType: a.entity.name, qbId: a.qbId, op: a.op });
    }
    const first = applied[0];
    return this.finalize(cmd, {
      status: 'succeeded',
      statusCode: 0,
      statusMessage: `Applied by an earlier attempt, confirmed by query: ${reason}`,
      result: {
        verification: { resent: false, outcome: 'applied', reason },
        ...(first?.ret ? { object: first.ret } : {}),
        changed,
      },
      objectId: cmd.object_id ?? first?.qbId ?? null,
      upserts,
      deletes,
      changed,
      audit: true,
      rqNames,
    });
  }

  /** Map QuickBooks' responses to the command outcome and write through. */
  private async complete(
    cmd: CommandRow,
    info: RequestInfo,
    rss: ParsedRs[],
    responseXml: string,
    isWrite: boolean,
    verification: { resent: boolean; reason: string } | undefined,
  ): Promise<ProcessResult> {
    const pairs = pairResponses(info, rss);
    const upserts: NonNullable<Finalize['upserts']> = [];
    const deletes: NonNullable<Finalize['deletes']> = [];
    const changed: ChangedObject[] = [];
    const warnings: string[] = [];
    const notProcessed: { requestID?: string; name: string }[] = [];
    let current: Ret | null | undefined;
    let currentError: string | undefined;
    let object: Ret | undefined;
    let newId: string | undefined;

    for (const { rq, rs } of pairs) {
      if (!rs) {
        notProcessed.push({
          ...(rq.requestID !== undefined ? { requestID: rq.requestID } : {}),
          name: rq.name,
        });
        continue;
      }
      if (isOk(rs)) {
        // Queries never touch the read model here: sync owns that, and query
        // options (IncludeLineItems, IncludeRetElement) can return partial objects.
        if (rq.readOnly) continue;
        const op = rq.op === 'Add' ? 'add' : rq.op === 'Mod' ? 'mod' : undefined;
        if (!rq.partial) {
          rs.rets.forEach((ret, i) => {
            const entity = entityOfRet(rs.retNames[i] ?? '');
            if (!entity?.idField) return;
            const id = textOf(ret[entity.idField]);
            if (!id) return;
            const group = upserts.find((u) => u.entity.name === entity.name);
            if (group) group.rets.push(ret);
            else upserts.push({ entity, rets: [ret] });
            changed.push({ objectType: entity.name, qbId: id, op: op ?? 'mod' });
            object ??= ret;
            if (op === 'add') newId ??= id;
          });
        }
        if (rs.name === 'ListDelRs' || rs.name === 'TxnDelRs') {
          const t = entityOfDelOrVoidRs(rs.name, rs.body);
          if (t) {
            deletes.push({ entity: t.entity, ids: [t.id] });
            changed.push({ objectType: t.entity.name, qbId: t.id, op: 'del' });
          }
        } else if (rs.name === 'TxnVoidRs') {
          const t = entityOfDelOrVoidRs(rs.name, rs.body);
          if (t) {
            changed.push({ objectType: t.entity.name, qbId: t.id, op: 'void' });
            // A void zeroes the amounts; re-read the transaction so the read model matches.
            try {
              if (this.lookup.canQueryById(t.entity)) {
                const ret = await this.lookup.byId(t.entity, t.id);
                if (ret) {
                  upserts.push({ entity: t.entity, rets: [ret] });
                  object ??= ret;
                } else {
                  warnings.push(`${t.entity.name} ${t.id} was not found after the void`);
                }
              }
            } catch (err) {
              warnings.push(
                `Could not refresh ${t.entity.name} ${t.id} after the void: ${(err as Error).message}`,
              );
            }
          }
        }
        continue;
      }
      if (rs.statusCode === EDIT_SEQUENCE_CONFLICT && current === undefined) {
        // Someone changed the object first. Fetch it so the UI can show a diff.
        const entity = entityOfRq(rq);
        const id = targetIdOfRq(rq, entity);
        if (entity && id && this.lookup.canQueryById(entity)) {
          try {
            current = await this.lookup.byId(entity, id);
            if (current) {
              upserts.push({ entity, rets: [current] });
              changed.push({ objectType: entity.name, qbId: id, op: 'sync' });
            }
          } catch (err) {
            currentError = (err as Error).message;
          }
        } else {
          currentError = `cannot look up the current ${entity?.name ?? 'object'}`;
        }
      }
    }

    const errored = pairs.find((p) => p.rs && !isOk(p.rs))?.rs;
    const first = rss[0];
    let status: Finalize['status'];
    let statusCode: number | null;
    let statusMessage: string;
    if (errored) {
      status = errored.statusCode === EDIT_SEQUENCE_CONFLICT ? 'conflict' : 'failed';
      statusCode = errored.statusCode;
      statusMessage = errored.statusMessage;
      if (pairs.length > 1) {
        statusMessage = `${errored.name}${errored.requestID !== undefined ? ` (requestID ${errored.requestID})` : ''}: ${statusMessage}`;
      }
      if (status === 'conflict' && verification?.resent) {
        statusMessage +=
          ' This command was resent after an interrupted attempt, so the change may already be in QuickBooks: compare with the current object.';
      }
    } else if (!first || notProcessed.length > 0) {
      status = 'failed';
      statusCode = first?.statusCode ?? null;
      statusMessage = `QuickBooks did not answer ${notProcessed.map((n) => n.requestID ?? n.name).join(', ') || 'the request'}`;
    } else {
      status = 'succeeded';
      statusCode = first.statusCode;
      statusMessage = first.statusMessage;
    }

    const result: Record<string, unknown> = {
      responses: pairs.map(({ rq, rs }) =>
        rs
          ? summarize(rs)
          : {
              ...(rq.requestID !== undefined ? { requestID: rq.requestID } : {}),
              name: rq.def?.response ?? rq.name.replace(/Rq$/, 'Rs'),
              notProcessed: true,
            },
      ),
    };
    if (isWrite) {
      if (object) result.object = object;
      result.changed = changed;
    }
    if (current !== undefined) result.current = current;
    if (currentError) result.currentError = currentError;
    if (notProcessed.length) result.notProcessed = notProcessed;
    if (warnings.length) result.warnings = warnings;
    if (verification) result.verification = { ...verification, outcome: 'resent' };

    return this.finalize(cmd, {
      status,
      statusCode,
      statusMessage,
      responseXml,
      result,
      objectId: cmd.object_id ?? newId ?? null,
      upserts,
      deletes,
      changed,
      audit: isWrite,
      rqNames: info.rqs.map((r) => r.name),
    });
  }

  /** Write-through, finish the command and audit in one transaction, then publish events. */
  private async finalize(cmd: CommandRow, f: Finalize): Promise<ProcessResult> {
    const row = await this.db.transaction().execute(async (trx) => {
      for (const u of f.upserts ?? []) await upsertObjects(trx, u.entity, u.rets);
      for (const d of f.deletes ?? []) await markDeleted(trx, d.entity.name, d.ids);
      const finished = await finishCommand(trx, cmd.id, {
        status: f.status,
        statusCode: f.statusCode ?? null,
        statusMessage: f.statusMessage ?? null,
        ...(f.responseXml !== undefined ? { responseXml: f.responseXml } : {}),
        result: (f.result ?? null) as JsonValue | null,
        ...(f.objectId !== undefined ? { objectId: f.objectId } : {}),
      });
      if (f.audit) {
        await writeAudit(trx, {
          actorType: cmd.actor_type,
          actorId: cmd.actor_id,
          action: `qb.${cmd.kind}`,
          objectType: cmd.object_type,
          objectId: f.objectId ?? cmd.object_id,
          commandId: cmd.id,
          detail: {
            status: f.status,
            statusCode: f.statusCode ?? null,
            statusMessage: f.statusMessage ?? null,
            requests: f.rqNames ?? (cmd.rq_name ? [cmd.rq_name] : []),
            changed: (f.changed ?? []) as unknown as JsonValue,
          },
        });
      }
      return finished;
    });
    const level = f.status === 'succeeded' ? 'info' : 'warn';
    this.log[level](
      {
        commandId: cmd.id,
        kind: cmd.kind,
        status: f.status,
        statusCode: f.statusCode ?? null,
        statusMessage: f.statusMessage,
      },
      'command finished',
    );
    if (row) await this.publishCommand(row);
    for (const c of f.changed ?? []) {
      await this.publish({
        type: 'object.changed',
        objectType: c.objectType,
        qbId: c.qbId,
        op: c.op,
      });
    }
    return { commandId: cmd.id, status: row?.status ?? f.status, ...(row ? { command: row } : {}) };
  }

  private async publishCommand(c: CommandRow): Promise<void> {
    await this.publish({
      type: 'command.updated',
      id: c.id,
      status: c.status,
      kind: c.kind,
      objectType: c.object_type,
      objectId: c.object_id,
      actorType: c.actor_type,
      actorId: c.actor_id,
    });
  }

  private async publish(e: Parameters<EventPublisher['publish']>[0]): Promise<void> {
    if (!this.opts.events) return;
    try {
      await this.opts.events.publish(e);
    } catch (err) {
      this.log.warn({ err, event: e.type }, 'could not publish event');
    }
  }
}
