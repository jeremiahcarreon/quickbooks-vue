import { sql } from 'kysely';
import type { Db } from './client.js';
import { jsonb } from './json.js';
import {
  TERMINAL_COMMAND_STATUSES,
  type ActorType,
  type CommandKind,
  type CommandRow,
  type CommandStatus,
  type JsonValue,
} from './schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);

export interface NewCommandInput {
  kind: CommandKind;
  rqName?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  payload?: JsonValue | null;
  /** The XSD-validated qbXML to send. */
  requestXml?: string | null;
  /** Lower runs first (see @qbv/queue Priority). Default 5. */
  priority?: number;
  actorType: ActorType;
  actorId?: string | null;
  /** Optional caller-chosen id (uuid). */
  id?: string;
}

export async function createCommand(db: Db, input: NewCommandInput): Promise<CommandRow> {
  return db
    .insertInto('command')
    .values({
      ...(input.id ? { id: input.id } : {}),
      kind: input.kind,
      rq_name: input.rqName ?? null,
      object_type: input.objectType ?? null,
      object_id: input.objectId ?? null,
      payload: input.payload === undefined || input.payload === null ? null : jsonb(input.payload),
      request_xml: input.requestXml ?? null,
      priority: input.priority ?? 5,
      actor_type: input.actorType,
      actor_id: input.actorId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getCommand(db: Db, id: string): Promise<CommandRow | undefined> {
  if (!isUuid(id)) return undefined;
  return db.selectFrom('command').selectAll().where('id', '=', id).executeTakeFirst();
}

export interface CommandPatch {
  status?: CommandStatus;
  requestXml?: string | null;
  responseXml?: string | null;
  statusCode?: number | null;
  statusMessage?: string | null;
  result?: JsonValue | null;
  objectId?: string | null;
  priority?: number;
}

function patchValues(p: CommandPatch) {
  const v: Record<string, unknown> = { updated_at: sql`now()` };
  if (p.status !== undefined) v.status = p.status;
  if (p.requestXml !== undefined) v.request_xml = p.requestXml;
  if (p.responseXml !== undefined) v.response_xml = p.responseXml;
  if (p.statusCode !== undefined) v.status_code = p.statusCode;
  if (p.statusMessage !== undefined) v.status_message = p.statusMessage;
  if (p.result !== undefined) v.result = p.result === null ? null : jsonb(p.result);
  if (p.objectId !== undefined) v.object_id = p.objectId;
  if (p.priority !== undefined) v.priority = p.priority;
  return v;
}

export async function updateCommand(
  db: Db,
  id: string,
  patch: CommandPatch,
): Promise<CommandRow | undefined> {
  if (!isUuid(id)) return undefined;
  return db
    .updateTable('command')
    .set(patchValues(patch))
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

/**
 * Claim a command for sending: queued|sending -> sending, attempts + 1,
 * started_at set on first attempt. Returns undefined if it is already final.
 */
export async function markCommandSending(db: Db, id: string): Promise<CommandRow | undefined> {
  if (!isUuid(id)) return undefined;
  return db
    .updateTable('command')
    .set({
      status: 'sending',
      attempts: sql`attempts + 1`,
      started_at: sql`coalesce(started_at, now())`,
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .where('status', 'in', ['queued', 'sending'])
    .returningAll()
    .executeTakeFirst();
}

/** Put a command back to queued (transient relay failure, will retry). */
export async function requeueCommand(
  db: Db,
  id: string,
  statusMessage?: string,
): Promise<CommandRow | undefined> {
  return updateCommand(db, id, { status: 'queued', statusMessage: statusMessage ?? null });
}

export interface FinishCommandInput {
  status: Extract<CommandStatus, 'succeeded' | 'failed' | 'conflict' | 'rejected'>;
  statusCode?: number | null;
  statusMessage?: string | null;
  responseXml?: string | null;
  result?: JsonValue | null;
  objectId?: string | null;
}

/** Set a final status and finished_at. */
export async function finishCommand(
  db: Db,
  id: string,
  input: FinishCommandInput,
): Promise<CommandRow | undefined> {
  if (!isUuid(id)) return undefined;
  return db
    .updateTable('command')
    .set({ ...patchValues(input), finished_at: sql`now()` })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

export function isTerminalStatus(s: CommandStatus): boolean {
  return TERMINAL_COMMAND_STATUSES.includes(s);
}

export interface ListCommandsQuery {
  status?: CommandStatus | CommandStatus[];
  kind?: CommandKind | CommandKind[];
  objectType?: string;
  objectId?: string;
  actorType?: ActorType;
  actorId?: string;
  /** Keyset cursor: return commands created before this command id. */
  before?: string;
  limit?: number;
}

/** Newest first, keyset-paginated with `before`. */
export async function listCommands(db: Db, q: ListCommandsQuery = {}): Promise<CommandRow[]> {
  const limit = Math.min(Math.max(1, q.limit ?? 50), 500);
  let query = db.selectFrom('command').selectAll();
  if (q.status)
    query = query.where('status', 'in', Array.isArray(q.status) ? q.status : [q.status]);
  if (q.kind) query = query.where('kind', 'in', Array.isArray(q.kind) ? q.kind : [q.kind]);
  if (q.objectType) query = query.where('object_type', '=', q.objectType);
  if (q.objectId) query = query.where('object_id', '=', q.objectId);
  if (q.actorType) query = query.where('actor_type', '=', q.actorType);
  if (q.actorId) query = query.where('actor_id', '=', q.actorId);
  if (q.before && isUuid(q.before)) {
    query = query.where(
      sql<boolean>`(created_at, id) < (select c2.created_at, c2.id from command c2 where c2.id = ${q.before})`,
    );
  }
  return query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
}

/** Commands still waiting or in flight (for the command tray / recovery on boot). */
export async function listPendingCommands(db: Db, limit = 1000): Promise<CommandRow[]> {
  return db
    .selectFrom('command')
    .selectAll()
    .where('status', 'in', ['queued', 'sending'])
    .orderBy('priority', 'asc')
    .orderBy('created_at', 'asc')
    .limit(limit)
    .execute();
}
