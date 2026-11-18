import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { finishCommand, getCommand, isTerminalStatus, type Db } from '@qbv/db';
import {
  type COMMAND_JOB,
  createRelayQueue,
  DEFAULT_QUEUE_PREFIX,
  RELAY_QUEUE,
  type RelayJobData,
  type RelayQueue,
} from '@qbv/queue';
import { RelayCircuit } from './circuit.js';
import { CommandProcessor, RetryLaterError } from './processor.js';
import { recoverPending, type RecoveryReport } from './recovery.js';
import {
  silentLogger,
  type EventPublisher,
  type Logger,
  type RelayLike,
  type Validator,
} from './types.js';

export interface RelayWorkerOptions {
  db: Db;
  /** ioredis connection (or options) for BullMQ; must use maxRetriesPerRequest: null. */
  connection: ConnectionOptions;
  /** BullMQ key prefix (QUEUE_PREFIX). */
  prefix?: string;
  relay: RelayLike;
  events?: EventPublisher;
  log?: Logger;
  validator?: Validator;
  qbxmlVersion?: string;
  /** Upper bound on attempts per command (WORKER_MAX_ATTEMPTS). Jobs carry their own attempts too; the lower wins. */
  maxAttempts?: number;
  /** RELAY_HEALTH_INTERVAL in ms. */
  healthIntervalMs?: number;
  /** CIRCUIT_BREAKER_COOLDOWN in ms. */
  cooldownMs?: number;
  /** WORKER_BACKOFF in ms: base of the exponential backoff for `custom` backoff jobs. */
  backoffMs?: number;
  /** BullMQ lock duration; renewed while a job runs. Default 60 s. */
  lockDurationMs?: number;
  /** Clock skew allowed when verifying interrupted Adds (ms). */
  clockSkewMs?: number;
}

/**
 * The single consumer of the `relay` queue. Concurrency is 1 in this process
 * and the queue's global concurrency is set to 1, so even a second worker
 * container cannot send QuickBooks two requests at once.
 */
export class RelayWorker {
  readonly queue: RelayQueue;
  readonly worker: Worker<RelayJobData, unknown, typeof COMMAND_JOB>;
  readonly circuit: RelayCircuit;
  readonly processor: CommandProcessor;
  private readonly log: Logger;
  private running = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly opts: RelayWorkerOptions) {
    this.log = opts.log ?? silentLogger;
    const prefix = opts.prefix ?? DEFAULT_QUEUE_PREFIX;
    this.queue = createRelayQueue(opts.connection, { prefix });
    this.circuit = new RelayCircuit({
      relay: opts.relay,
      cooldownMs: opts.cooldownMs ?? 30_000,
      healthIntervalMs: opts.healthIntervalMs ?? 15_000,
      log: this.log,
      onOpen: () => this.worker.pause(true),
      onHalfOpen: () => this.worker.resume(),
      onHealth: async (connected, error) => {
        await opts.events
          ?.publish({ type: 'relay.health', connected, error })
          .catch((err: unknown) => this.log.warn({ err }, 'could not publish relay.health'));
      },
    });
    this.processor = new CommandProcessor({
      db: opts.db,
      relay: opts.relay,
      events: opts.events,
      log: this.log,
      validator: opts.validator,
      qbxmlVersion: opts.qbxmlVersion,
      circuit: this.circuit,
      clockSkewMs: opts.clockSkewMs,
    });
    this.worker = new Worker<RelayJobData, unknown, typeof COMMAND_JOB>(
      RELAY_QUEUE,
      (job) => this.handle(job),
      {
        connection: opts.connection,
        prefix,
        concurrency: 1,
        autorun: false,
        lockDuration: opts.lockDurationMs ?? 60_000,
        // Used by jobs enqueued with `backoff: { type: 'custom' }`; jobs from
        // @qbv/queue enqueueCommand carry their own exponential backoff.
        settings: {
          backoffStrategy: (attemptsMade: number) =>
            (opts.backoffMs ?? 2000) * 2 ** Math.max(0, attemptsMade - 1),
        },
      },
    );
    this.worker.on('failed', (job, err) => void this.onFailed(job, err));
    this.worker.on('error', (err) => this.log.error({ err }, 'worker error'));
    this.worker.on('stalled', (jobId) =>
      this.log.warn({ commandId: jobId }, 'job stalled; it will be checked before any resend'),
    );
  }

  private async handle(job: Job<RelayJobData, unknown, typeof COMMAND_JOB>): Promise<unknown> {
    const maxAttempts = Math.max(
      1,
      Math.min(job.opts.attempts ?? 1, this.opts.maxAttempts ?? Number.POSITIVE_INFINITY),
    );
    const r = await this.processor.process(job.data.commandId, {
      attemptsMade: job.attemptsMade,
      maxAttempts,
    });
    if (r.status === 'skipped')
      this.log.debug({ commandId: r.commandId, reason: r.reason }, 'job skipped');
    return { status: r.status };
  }

  /** Safety net: a job that failed for good must not leave its command queued/sending. */
  private async onFailed(job: Job<RelayJobData> | undefined, err: Error): Promise<void> {
    if (!job) return;
    const final = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!final || err instanceof RetryLaterError) {
      if (!(err instanceof RetryLaterError)) {
        this.log.error({ err, commandId: job.data.commandId }, 'job attempt failed, will retry');
      }
      return;
    }
    try {
      const cmd = await getCommand(this.opts.db, job.data.commandId);
      if (!cmd || isTerminalStatus(cmd.status)) return;
      const uncertain = cmd.status === 'sending' && cmd.kind !== 'query' && cmd.kind !== 'report';
      const row = await finishCommand(this.opts.db, cmd.id, {
        status: 'failed',
        statusMessage:
          `Worker error: ${err.message}` +
          (uncertain
            ? ' QuickBooks may have applied this change; check before submitting it again.'
            : ''),
      });
      if (row) {
        await this.opts.events
          ?.publish({
            type: 'command.updated',
            id: row.id,
            status: row.status,
            kind: row.kind,
            objectType: row.object_type,
            objectId: row.object_id,
            actorType: row.actor_type,
            actorId: row.actor_id,
          })
          .catch(() => undefined);
      }
    } catch (e) {
      this.log.error({ err: e, commandId: job.data.commandId }, 'could not mark failed command');
    }
  }

  /** Recover pending commands, start health checks and begin consuming. */
  async start(): Promise<RecoveryReport> {
    if (this.running) throw new Error('worker already started');
    this.running = true;
    await this.queue.setGlobalConcurrency(1);
    const report = await recoverPending(this.opts.db, this.queue, this.log);
    this.circuit.start();
    void this.worker
      .run()
      .catch((err: unknown) => this.log.error({ err }, 'worker stopped with an error'));
    await this.worker.waitUntilReady();
    this.log.info({ ...report }, 'worker started');
    return report;
  }

  /**
   * Stop taking jobs and wait for the one in flight to finish (its relay call
   * can take up to RELAY_TIMEOUT_MS). `force` abandons it: its command stays
   * `sending` and is checked by query before any resend on the next start.
   */
  close(force = false): Promise<void> {
    this.closing ??= (async () => {
      this.circuit.stop();
      await this.worker.close(force);
      await this.queue.close();
      this.running = false;
    })();
    return this.closing;
  }
}
