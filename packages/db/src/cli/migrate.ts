#!/usr/bin/env node
import { createLogger, loadConfig } from '@qbv/config';
import { createDbFromConfig } from '../client.js';
import { migrateDown, migrateToLatest, migrateUp, migrationStatus } from '../migrator.js';

const cmd = process.argv[2] ?? 'latest';
const config = loadConfig('migrate');
const log = createLogger({
  service: 'migrate',
  level: config.LOG_LEVEL,
  pretty: config.LOG_PRETTY,
});
const db = createDbFromConfig(config, 'qbv-migrate');

try {
  if (cmd === 'status') {
    for (const m of await migrationStatus(db)) {
      console.log(
        `${m.executedAt ? 'applied ' + m.executedAt.toISOString() : 'pending'}\t${m.name}`,
      );
    }
  } else {
    const fn = { latest: migrateToLatest, up: migrateUp, down: migrateDown }[cmd];
    if (!fn) {
      console.error('usage: migrate [latest|up|down|status]');
      process.exitCode = 2;
    } else {
      const res = await fn(db);
      for (const r of res.results ?? [])
        log.info({ migration: r.migrationName, direction: r.direction }, r.status);
      if (!res.results?.length) log.info('nothing to migrate');
    }
  }
} catch (err) {
  log.error({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await db.destroy();
}
