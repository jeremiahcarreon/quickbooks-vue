#!/usr/bin/env node
import { loadSchema } from '@qbv/qbxml';
import { createLogger } from '@qbv/config';
import { loadMockConfig } from './config.js';
import { Engine } from './engine.js';
import { RelayMock } from './server.js';

const config = loadMockConfig();
const logger = createLogger({
  service: 'relay-mock',
  level: config.LOG_LEVEL,
  pretty: config.LOG_PRETTY,
});

await loadSchema(config.QBXML_SCHEMA_DIR);

const engine = new Engine({
  companyName: config.MOCK_COMPANY_NAME,
  onInternalError: (err, rq) => logger.error({ err, rq }, 'relay mock internal error'),
});
const mock = new RelayMock({
  engine,
  apiKey: config.RELAY_API_KEY,
  allowedIps: config.MOCK_ALLOWED_IPS,
  latencyMs: config.MOCK_LATENCY_MS,
  latencyJitterMs: config.MOCK_LATENCY_JITTER_MS,
  requestTimeoutMs: config.MOCK_REQUEST_TIMEOUT_MS,
  dataFile: config.MOCK_DATA_FILE,
  seed: config.SEED ? { anchor: config.MOCK_SEED_ANCHOR } : false,
  logger,
});
const { url } = await mock.listen(config.RELAY_MOCK_PORT, config.RELAY_MOCK_HOST);
logger.info(
  { url, objects: engine.store.size, keyCheck: config.RELAY_API_KEY ? 'on' : 'off' },
  'relay mock listening',
);

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  mock.close().then(
    () => process.exit(0),
    (err: unknown) => {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    },
  );
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
