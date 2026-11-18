import { hostname } from 'node:os';
import { parseBool, parseDuration, type SyncConfig } from '@qbv/config';
import { createDb, type Db } from '@qbv/db';
import { loadSchema } from '@qbv/qbxml';
import {
  createEventBus,
  createRedis,
  createRelayQueue,
  type EventBus,
  type RelayQueue,
} from '@qbv/queue';
import type { Redis } from 'ioredis';
import { SyncEngine, type Logger } from './engine.js';
import { LeaderLock } from './lock.js';
import { planSync, type SyncPlan } from './plan.js';
import { QueueQueryRunner } from './runner.js';
import { SyncScheduler } from './scheduler.js';

/**
 * Settings read by the sync service that are not part of @qbv/config's sync
 * schema (see README). Unset or empty values use the defaults.
 */
export interface SyncExtraConfig {
  /** Overlap subtracted from the cursor (default 1m). */
  overlapMs: number;
  /** Max wait for one relay command, including queue time (default 30m). */
  commandTimeoutMs: number;
  /** Drop response_xml from processed sync commands (default true). */
  pruneResponses: boolean;
  /** Request public custom fields (OwnerID 0) (default true). */
  includeCustomFields: boolean;
  /** Leader lock TTL (default 30s). */
  lockTtlMs: number;
}

export function loadExtraConfig(
  env: Record<string, string | undefined> = process.env,
): SyncExtraConfig {
  const v = (k: string) => (env[k] === undefined || env[k] === '' ? undefined : env[k]);
  return {
    overlapMs: parseDuration(v('SYNC_OVERLAP') ?? '1m', 's'),
    commandTimeoutMs: parseDuration(v('SYNC_COMMAND_TIMEOUT') ?? '30m', 's'),
    pruneResponses: parseBool(v('SYNC_PRUNE_RESPONSES') ?? 'true'),
    includeCustomFields: parseBool(v('SYNC_INCLUDE_CUSTOM_FIELDS') ?? 'true'),
    lockTtlMs: parseDuration(v('SYNC_LOCK_TTL') ?? '30s', 's'),
  };
}

export interface SyncService {
  plan: SyncPlan;
  engine: SyncEngine;
  scheduler: SyncScheduler;
  lock: LeaderLock;
  db: Db;
  redis: Redis;
  queue: RelayQueue;
  events: EventBus;
  stop(): Promise<void>;
}

/** Wire the sync service from config. Call `scheduler.start()` to begin. */
export async function createSyncService(
  config: SyncConfig,
  logger: Logger,
  extra: SyncExtraConfig = loadExtraConfig(),
): Promise<SyncService> {
  // Compile the XSD up front so a missing schema fails at start, not mid-sync.
  await loadSchema(config.QBXML_SCHEMA_DIR);
  const plan = planSync({ include: config.SYNC_ENTITIES });
  for (const s of plan.skipped)
    logger.debug({ entity: s.entity, reason: s.reason }, 'entity not synced');
  logger.info({ units: plan.units.length, skipped: plan.skipped.length }, 'sync plan ready');

  const db = createDb({
    connectionString: config.DATABASE_URL,
    max: Math.min(config.DATABASE_POOL_MAX, 5),
    ssl: config.DATABASE_SSL,
    applicationName: 'qbv-sync',
  });
  const redis = createRedis(config.REDIS_URL);
  const queue = createRelayQueue(redis, { prefix: config.QUEUE_PREFIX });
  const events = createEventBus(config.REDIS_URL, {
    onError: (err) => logger.warn({ err: err.message }, 'event bus error'),
  });

  const runner = new QueueQueryRunner(db, queue, {
    events,
    timeoutMs: extra.commandTimeoutMs,
    pruneResponses: extra.pruneResponses,
  });
  const engine = new SyncEngine({
    db,
    runner,
    events,
    logger,
    version: config.QBXML_VERSION,
    pageSize: config.SYNC_PAGE_SIZE,
    overlapMs: extra.overlapMs,
    includeCustomFields: extra.includeCustomFields,
  });

  const holder: { scheduler?: SyncScheduler } = {};
  const lock = new LeaderLock(redis, {
    key: `${config.QUEUE_PREFIX}:sync:leader`,
    ttlMs: extra.lockTtlMs,
    owner: `${hostname()}:${process.pid}`,
    onAcquired: () => logger.info({}, 'sync leader lock acquired'),
    onLost: () => {
      logger.warn({}, 'sync leader lock lost; pausing');
      holder.scheduler?.interrupt();
    },
    onError: (err) => logger.warn({ err: err.message }, 'leader lock error'),
  });
  const scheduler = new SyncScheduler({
    engine,
    plan,
    redis,
    prefix: config.QUEUE_PREFIX,
    intervalMs: config.SYNC_INTERVAL,
    fullIntervalMs: config.SYNC_FULL_INTERVAL,
    reconcileCron: config.SYNC_RECONCILE_CRON,
    lock,
    logger,
  });
  holder.scheduler = scheduler;

  return {
    plan,
    engine,
    scheduler,
    lock,
    db,
    redis,
    queue,
    events,
    async stop() {
      await scheduler.stop();
      await queue.close().catch(() => undefined);
      await events.close().catch(() => undefined);
      await redis.quit().catch(() => redis.disconnect());
      await db.destroy();
    },
  };
}
