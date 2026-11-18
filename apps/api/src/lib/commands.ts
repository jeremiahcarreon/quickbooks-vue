import type { FastifyReply, FastifyRequest } from 'fastify';
import { getObject, writeAudit, type CommandKind, type CommandRow, type JsonValue } from '@qbv/db';
import { buildRequest, parseResponse, type ParsedRs } from '@qbv/qbxml';
import { enqueueCommand, Priority, waitForCommand } from '@qbv/queue';
import type { AppDeps } from '../types.js';
import { actorOf, clientIp, requirePrincipal } from './auth.js';
import { errorBody } from './errors.js';
import { commandView, objectView } from './views.js';

export interface SubmitInput {
  kind: CommandKind;
  rq: string;
  /** Content of the Rq element, passed to buildRequest (ordered + XSD-validated). */
  body: object;
  objectType?: string | null;
  objectId?: string | null;
  payload?: JsonValue | null;
  priority?: number;
  /** Audit action, e.g. object.add. */
  action: string;
  /** Document already built with buildRequest (XSD-validated) from `rq` and `body`. */
  xml?: string;
}

/**
 * Build the qbXML for a write (buildRequest validates against the XSD and
 * throws QbxmlValidationError, which the error handler turns into a 400; the
 * command is then never stored or queued), enqueue it (enqueueCommand
 * validates again) and write the audit row.
 */
export async function submitCommand(
  deps: AppDeps,
  req: FastifyRequest,
  input: SubmitInput,
): Promise<CommandRow> {
  const principal = requirePrincipal(req);
  const xml =
    input.xml ?? buildRequest(input.rq, input.body, { version: deps.config.QBXML_VERSION });
  const { command } = await enqueueCommand(
    deps.db,
    deps.queue,
    {
      kind: input.kind,
      rqName: input.rq,
      objectType: input.objectType ?? null,
      objectId: input.objectId ?? null,
      payload: input.payload ?? null,
      requestXml: xml,
      priority: input.priority ?? Priority.InteractiveWrite,
      ...actorOf(principal),
    },
    { events: deps.events },
  );
  await writeAudit(deps.db, {
    ...actorOf(principal),
    action: input.action,
    objectType: input.objectType ?? null,
    objectId: input.objectId ?? null,
    commandId: command.id,
    ip: clientIp(req),
    detail: { rq: input.rq },
  });
  return command;
}

/**
 * Reply for a command whose QuickBooks response the caller wants back (live
 * queries, SDK actions): 202 when not waiting or not finished in time; 400
 * when rejected before sending; 502 when it failed without a response;
 * otherwise 200 `{commandId, status, statusCode, statusMessage, responses}`
 * with every response parsed by @qbv/qbxml.
 */
export async function replyWithResponse(
  deps: AppDeps,
  reply: FastifyReply,
  command: CommandRow,
  wait: boolean,
  shape: (responses: ParsedRs[], c: CommandRow) => Record<string, unknown> = () => ({}),
) {
  if (!wait) {
    return reply
      .code(202)
      .send({ commandId: command.id, status: command.status, command: commandView(command) });
  }
  const res = await waitFor(deps, reply, command.id);
  const c = res.command ?? command;
  if (!res.done) {
    return reply.code(202).send({ commandId: c.id, status: c.status, command: commandView(c) });
  }
  if (!c.response_xml) {
    const rejected = c.status === 'rejected';
    return reply
      .code(rejected ? 400 : 502)
      .send(
        errorBody(
          rejected ? 'qbxml_rejected' : 'relay_error',
          c.status_message ?? `Command ${c.status} without a QuickBooks response`,
          { commandId: c.id, command: commandView(c) },
        ),
      );
  }
  let responses: ParsedRs[] = [];
  try {
    responses = parseResponse(c.response_xml);
  } catch (err) {
    return reply.code(502).send(
      errorBody('relay_error', `Unreadable QuickBooks response: ${(err as Error).message}`, {
        commandId: c.id,
      }),
    );
  }
  return reply.code(200).send({
    commandId: c.id,
    status: c.status,
    statusCode: c.status_code,
    statusMessage: c.status_message,
    responses: responses.map(({ raw: _raw, ...r }) => r),
    ...shape(responses, c),
  });
}

/** Abort signal that fires when the client goes away. */
export function disconnectSignal(reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  reply.raw.once('close', () => ac.abort());
  return ac.signal;
}

/** Wait (bounded by COMMAND_WAIT_TIMEOUT) for a command to finish. */
export async function waitFor(deps: AppDeps, reply: FastifyReply, id: string) {
  return waitForCommand(deps.db, id, {
    events: deps.events,
    timeoutMs: deps.config.COMMAND_WAIT_TIMEOUT,
    signal: disconnectSignal(reply),
  });
}

/**
 * Reply for a write: 202 when not waiting or not finished in time; otherwise
 * 200 (succeeded, with the refreshed object), 409 (conflict), 422 (QuickBooks
 * error) or 400 (rejected by validation before sending).
 */
export async function replyWithCommand(
  deps: AppDeps,
  reply: FastifyReply,
  command: CommandRow,
  wait: boolean,
) {
  if (!wait) {
    return reply
      .code(202)
      .send({ commandId: command.id, status: command.status, command: commandView(command) });
  }
  const res = await waitFor(deps, reply, command.id);
  const c = res.command ?? command;
  if (!res.done) {
    return reply.code(202).send({ commandId: c.id, status: c.status, command: commandView(c) });
  }
  const view = commandView(c);
  switch (c.status) {
    case 'succeeded': {
      const obj =
        c.object_type && c.object_id
          ? await getObject(deps.db, c.object_type, c.object_id, { includeDeleted: true })
          : undefined;
      return reply.code(200).send({
        commandId: c.id,
        status: c.status,
        command: view,
        object: obj ? objectView(obj) : null,
      });
    }
    case 'conflict':
      return reply.code(409).send(
        errorBody('conflict', c.status_message ?? 'The object was changed in QuickBooks', {
          commandId: c.id,
          statusCode: c.status_code,
          command: view,
        }),
      );
    case 'rejected':
      return reply.code(400).send(
        errorBody('qbxml_rejected', c.status_message ?? 'Rejected before sending', {
          commandId: c.id,
          command: view,
        }),
      );
    default:
      return reply.code(422).send(
        errorBody('qb_error', c.status_message ?? 'QuickBooks returned an error', {
          commandId: c.id,
          statusCode: c.status_code,
          command: view,
        }),
      );
  }
}
