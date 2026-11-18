import { Queue, QueueEvents, type ConnectionOptions, type Job, type JobsOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';
import {
  createCommand,
  finishCommand,
  getCommand,
  listPendingCommands,
  TERMINAL_COMMAND_STATUSES,
  type CommandRow,
  type Db,
  type NewCommandInput,
} from '@qbv/db';
import type { EventBus } from './events.js';
import { assertValidQbxml, type QbxmlValidator } from './validator.js';

/** The single BullMQ queue consumed by the worker (concurrency 1). */
export const RELAY_QUEUE = 'relay';
/** Job name for every relay job. */
export const COMMAND_JOB = 'command';
/** Default BullMQ key prefix (QUEUE_PREFIX). */
export const DEFAULT_QUEUE_PREFIX = 'qbv';

/** Lower runs first. */
export const Priority = {
  InteractiveWrite: 1,
  InteractiveRead: 2,
  IncrementalSync: 5,
  ReportFetch: 8,
  BulkSync: 10,
} as const;
export type PriorityValue = (typeof Priority)[keyof typeof Priority];

/** Job payload: the command row holds everything else. */
export interface RelayJobData {
  commandId: string;
}
export type RelayQueue = Queue<RelayJobData, unknown, typeof COMMAND_JOB>;
export type RelayJob = Job<RelayJobData, unknown, typeof COMMAND_JOB>;

/** ioredis connection suitable for BullMQ queues and workers. */
export function createRedis(url: string, opts: RedisOptions = {}): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, ...opts });
}

export function createRelayQueue(
  connection: ConnectionOptions,
  opts: { prefix?: string } = {},
): RelayQueue {
  return new Queue<RelayJobData, unknown, typeof COMMAND_JOB>(RELAY_QUEUE, {
    connection,
    prefix: opts.prefix ?? DEFAULT_QUEUE_PREFIX,
  });
}

export function createRelayQueueEvents(
  connection: ConnectionOptions,
  opts: { prefix?: string } = {},
): QueueEvents {
  return new QueueEvents(RELAY_QUEUE, { connection, prefix: opts.prefix ?? DEFAULT_QUEUE_PREFIX });
}

/**
 * Default job options. Retries (attempts/backoff) are for transient relay
 * failures: the worker throws on 503/504/network errors and returns normally
 * for anything QuickBooks answered.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export interface EnqueueOptions {
  /** XSD validator; defaults to @qbv/qbxml `validate`. */
  validator?: QbxmlValidator;
  jobOptions?: JobsOptions;
  /** Publish `command.updated` (queued) when given. */
  events?: EventBus;
}

export interface EnqueueResult {
  command: CommandRow;
  job: RelayJob;
}

/**
 * Validate `requestXml` against the XSD (throws QbxmlRejectedError, nothing
 * stored), insert the command row (status queued) and add the relay job with
 * jobId = command id. If the job cannot be added the command is marked failed.
 */
export async function enqueueCommand(
  db: Db,
  queue: RelayQueue,
  input: NewCommandInput & { priority: number },
  opts: EnqueueOptions = {},
): Promise<EnqueueResult> {
  if (input.requestXml) await assertValidQbxml(input.requestXml, opts.validator);
  const command = await createCommand(db, input);
  let job: RelayJob;
  try {
    job = await queue.add(
      COMMAND_JOB,
      { commandId: command.id },
      { ...DEFAULT_JOB_OPTIONS, ...opts.jobOptions, jobId: command.id, priority: input.priority },
    );
  } catch (err) {
    await finishCommand(db, command.id, {
      status: 'failed',
      statusMessage: `Could not enqueue: ${(err as Error).message}`,
    });
    throw err;
  }
  await opts.events
    ?.publish({
      type: 'command.updated',
      id: command.id,
      status: command.status,
      kind: command.kind,
      objectType: command.object_type,
      objectId: command.object_id,
      actorType: command.actor_type,
      actorId: command.actor_id,
    })
    .catch(() => undefined);
  return { command, job };
}

/**
 * Re-add jobs for commands still queued/sending (e.g. after Redis was
 * flushed). Safe to repeat: jobId = command id, so existing jobs are kept.
 */
export async function reenqueuePending(
  db: Db,
  queue: RelayQueue,
  jobOptions?: JobsOptions,
): Promise<number> {
  const pending = await listPendingCommands(db);
  for (const c of pending) {
    await queue.add(
      COMMAND_JOB,
      { commandId: c.id },
      { ...DEFAULT_JOB_OPTIONS, ...jobOptions, jobId: c.id, priority: c.priority },
    );
  }
  return pending.length;
}

export interface WaitResult {
  command: CommandRow | undefined;
  /** True when the command reached a final status before the timeout. */
  done: boolean;
}

const isFinal = (c: CommandRow | undefined): boolean =>
  !!c && TERMINAL_COMMAND_STATUSES.includes(c.status);

/**
 * Wait until a command reaches a final status (succeeded, failed, conflict,
 * rejected) or the timeout passes. Listens for `command.updated` when an
 * event bus is given, and polls the database as a fallback.
 */
export async function waitForCommand(
  db: Db,
  commandId: string,
  opts: { events?: EventBus; timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? (opts.events ? 2000 : 250);

  return new Promise<WaitResult>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let checking = false;
    let latest: CommandRow | undefined;
    const timers: NodeJS.Timeout[] = [];

    const finish = (r: WaitResult | Error) => {
      if (settled) return;
      settled = true;
      timers.forEach((t) => clearTimeout(t));
      clearInterval(poller);
      unsubscribe?.();
      opts.signal?.removeEventListener('abort', onAbort);
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    const check = async () => {
      if (settled || checking) return;
      checking = true;
      try {
        latest = await getCommand(db, commandId);
        if (!latest) finish({ command: undefined, done: false });
        else if (isFinal(latest)) finish({ command: latest, done: true });
      } catch (err) {
        finish(err as Error);
      } finally {
        checking = false;
      }
    };
    const onAbort = () => finish({ command: latest, done: false });

    const poller = setInterval(() => void check(), pollMs);
    timers.push(
      setTimeout(async () => {
        await check();
        finish({ command: latest, done: false });
      }, timeoutMs),
    );
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    void (async () => {
      if (opts.events) {
        try {
          const unsub = await opts.events.subscribe((e) => {
            if (e.type === 'command.updated' && e.id === commandId) void check();
          });
          if (settled) unsub();
          else unsubscribe = unsub;
        } catch {
          // fall back to polling
        }
      }
      await check();
    })();
  });
}
