import type { ApiConfig, Logger } from '@qbv/config';
import { createDbFromConfig } from '@qbv/db';
import { createEventBus, createRedis, createRelayQueue } from '@qbv/queue';
import { relayClientFromConfig } from '@qbv/relay-client';
import type { AppDeps } from './types.js';

/** Open every connection the api needs. */
export function createDeps(
  config: ApiConfig,
  logger?: Logger,
  opts: { eventsChannel?: string } = {},
): AppDeps {
  const db = createDbFromConfig(config, 'qbv-api');
  const redis = createRedis(config.REDIS_URL);
  const queue = createRelayQueue(redis, { prefix: config.QUEUE_PREFIX });
  const events = createEventBus(config.REDIS_URL, {
    channel: opts.eventsChannel,
    onError: (err) => logger?.warn({ err }, 'event bus error'),
  });
  const relay = config.RELAY_URL
    ? relayClientFromConfig({
        RELAY_URL: config.RELAY_URL,
        RELAY_API_KEY: config.RELAY_API_KEY,
        RELAY_TIMEOUT_MS: config.RELAY_TIMEOUT_MS,
      })
    : undefined;
  return { config, db, redis, queue, events, relay, logger };
}

export async function closeDeps(deps: AppDeps): Promise<void> {
  await deps.events.close().catch(() => undefined);
  await deps.queue.close().catch(() => undefined);
  await deps.redis.quit().catch(() => deps.redis.disconnect());
  await deps.db.destroy().catch(() => undefined);
}
