import { loadConfig, loggerFromConfig } from '@qbv/config';
import { createSyncService } from './service.js';

const config = loadConfig('sync');
const logger = loggerFromConfig('sync', config);

async function main(): Promise<void> {
  if (!config.SYNC_ENABLED) {
    logger.info({}, 'SYNC_ENABLED is false; sync is idle');
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    return;
  }
  const service = await createSyncService(config, logger);
  service.scheduler.start();
  logger.info(
    {
      interval: config.SYNC_INTERVAL,
      fullInterval: config.SYNC_FULL_INTERVAL,
      reconcile: config.SYNC_RECONCILE_CRON,
    },
    'sync started',
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'sync stopping');
    try {
      await service.stop();
      process.exit(0);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'error while stopping');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal(
    { err: (err as Error).message, stack: (err as Error).stack },
    'sync failed to start',
  );
  process.exit(1);
});
