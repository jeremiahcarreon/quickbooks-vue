import { ConfigError, loadConfig, loggerFromConfig } from '@qbv/config';
import { buildApp } from './app.js';
import { closeDeps, createDeps } from './deps.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig('api');
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const logger = loggerFromConfig('api', config);
  const deps = createDeps(config, logger);
  const app = await buildApp(deps);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await app.close();
      await closeDeps(deps);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
