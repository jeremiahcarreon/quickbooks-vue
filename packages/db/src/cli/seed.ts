#!/usr/bin/env node
import { createLogger, loadConfig } from '@qbv/config';
import { createDbFromConfig } from '../client.js';
import { seed } from '../seed.js';

const config = loadConfig('seed');
const log = createLogger({ service: 'seed', level: config.LOG_LEVEL, pretty: config.LOG_PRETTY });
const db = createDbFromConfig(config, 'qbv-seed');

try {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
    log.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set: creating roles only');
  }
  const res = await seed(db, {
    adminEmail: config.ADMIN_EMAIL,
    adminPassword: config.ADMIN_PASSWORD,
    adminName: config.ADMIN_NAME,
  });
  log.info(res, 'seed complete');
} catch (err) {
  log.error({ err }, 'seed failed');
  process.exitCode = 1;
} finally {
  await db.destroy();
}
