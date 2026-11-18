import { loadConfig, loggerFromConfig } from '@qbv/config';
import { createDbFromConfig } from '@qbv/db';
import { loadSchema } from '@qbv/qbxml';
import { createEventBus, createRedis } from '@qbv/queue';
import { relayClientFromConfig } from '@qbv/relay-client';
import { RelayWorker } from './worker.js';

async function main(): Promise<void> {
  const config = loadConfig('worker');
  const log = loggerFromConfig('worker', config);

  // Fail fast if the XSDs are missing: nothing may be sent without validation.
  await loadSchema(config.QBXML_SCHEMA_DIR);

  const db = createDbFromConfig(config, 'qbv-worker');
  const connection = createRedis(config.REDIS_URL);
  const events = createEventBus(config.REDIS_URL, {
    onError: (err) => log.warn({ err }, 'event bus error'),
  });
  const relay = relayClientFromConfig(config);

  const worker = new RelayWorker({
    db,
    connection,
    prefix: config.QUEUE_PREFIX,
    relay,
    events,
    log,
    qbxmlVersion: config.QBXML_VERSION,
    maxAttempts: config.WORKER_MAX_ATTEMPTS,
    backoffMs: config.WORKER_BACKOFF,
    healthIntervalMs: config.RELAY_HEALTH_INTERVAL,
    cooldownMs: config.CIRCUIT_BREAKER_COOLDOWN,
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      log.warn(
        { signal },
        'second signal, exiting now; the in-flight command is checked on next start',
      );
      process.exit(1);
    }
    stopping = true;
    log.info({ signal }, 'shutting down: finishing the command in flight');
    void (async () => {
      try {
        await worker.close();
        await events.close();
        await connection.quit().catch(() => connection.disconnect());
        await db.destroy();
        log.info('worker stopped');
        process.exit(0);
      } catch (err) {
        log.error({ err }, 'error during shutdown');
        process.exit(1);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await worker.start();
  log.info(
    { relay: relay.baseUrl, prefix: config.QUEUE_PREFIX, maxAttempts: config.WORKER_MAX_ATTEMPTS },
    'relay worker running',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
