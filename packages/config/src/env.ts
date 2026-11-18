import { z } from 'zod';
import { zBool, zDuration, zInt, zList, zUrl } from './parsers.js';

/**
 * Environment fragments. Every service composes the fragments it needs.
 * Duration values are parsed into milliseconds. See docs/configuration.md.
 */
export const commonEnv = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: zBool(false),
});

export const databaseEnv = z.object({
  DATABASE_URL: zUrl(['postgres', 'postgresql']),
  DATABASE_POOL_MAX: zInt(10, { min: 1, max: 200 }),
  DATABASE_SSL: zBool(false),
});

export const redisEnv = z.object({
  REDIS_URL: zUrl(['redis', 'rediss']),
  QUEUE_PREFIX: z.string().min(1).default('qbv'),
});

export const relayEnv = z.object({
  RELAY_URL: zUrl(['http', 'https']),
  RELAY_API_KEY: z.string().default(''),
  /** Client-side timeout for one relay call (ms). The relay's own limit is 120s. */
  RELAY_TIMEOUT_MS: zDuration('130000'),
});

export const qbxmlEnv = z.object({
  /** Version written into the `<?qbxml version?>` header. Validation always uses the 17.0 XSD. */
  QBXML_VERSION: z
    .string()
    .regex(/^\d+\.\d+$/, 'must look like 16.0')
    .default('16.0'),
  /** Directory holding QBUqbxmlops170.xsd. Unset = @qbv/qbxml default (schemas/qbxml/17.0). */
  QBXML_SCHEMA_DIR: z.string().min(1).optional(),
});

export const apiEnv = z.object({
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: zInt(3100, { min: 1, max: 65535 }),
  PUBLIC_URL: zUrl(['http', 'https']).default('http://localhost:8180'),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  SESSION_TTL: zDuration('12h'),
  COOKIE_SECURE: zBool(true),
  TRUST_PROXY: zBool(false),
  CORS_ORIGINS: zList(),
  RATE_LIMIT_WRITES_PER_MIN: zInt(120, { min: 1 }),
  RATE_LIMIT_QBXML_PER_MIN: zInt(60, { min: 1 }),
  COMMAND_WAIT_TIMEOUT: zDuration('30s'),
  /** Optional relay settings, used only to report relay health directly. */
  RELAY_URL: zUrl(['http', 'https']).optional(),
  RELAY_API_KEY: z.string().default(''),
  RELAY_TIMEOUT_MS: zDuration('130000'),
});

export const workerEnv = z.object({
  WORKER_MAX_ATTEMPTS: zInt(5, { min: 1, max: 50 }),
  WORKER_BACKOFF: zDuration('2s'),
  RELAY_HEALTH_INTERVAL: zDuration('15s'),
  CIRCUIT_BREAKER_COOLDOWN: zDuration('30s'),
});

export const syncEnv = z.object({
  SYNC_ENABLED: zBool(true),
  /** Incremental sync interval. A bare number is seconds. */
  SYNC_INTERVAL: zDuration('60s', 's'),
  /** Full re-query interval for entities without a modified-date filter. A bare number is seconds. */
  SYNC_FULL_INTERVAL: zDuration('1h', 's'),
  SYNC_PAGE_SIZE: zInt(500, { min: 1, max: 10000 }),
  SYNC_RECONCILE_CRON: z.string().default('0 3 * * *'),
  /** Comma list of entity names to sync. Empty = every entity with a query op. */
  SYNC_ENTITIES: zList(),
});

export const reportsEnv = z.object({
  REPORT_CACHE_TTL: zDuration('15m', 's'),
});

export const relayMockEnv = z.object({
  RELAY_MOCK_HOST: z.string().default('0.0.0.0'),
  RELAY_MOCK_PORT: zInt(9223, { min: 1, max: 65535 }),
  RELAY_API_KEY: z.string().default(''),
});

export const seedEnv = z.object({
  ADMIN_EMAIL: z.string().trim().toLowerCase().email().optional(),
  ADMIN_PASSWORD: z.string().min(12, 'must be at least 12 characters').optional(),
  ADMIN_NAME: z.string().default('Administrator'),
});

export const serviceSchemas = {
  api: commonEnv.merge(databaseEnv).merge(redisEnv).merge(qbxmlEnv).merge(reportsEnv).merge(apiEnv),
  worker: commonEnv
    .merge(databaseEnv)
    .merge(redisEnv)
    .merge(qbxmlEnv)
    .merge(relayEnv)
    .merge(workerEnv),
  sync: commonEnv.merge(databaseEnv).merge(redisEnv).merge(qbxmlEnv).merge(syncEnv),
  'relay-mock': commonEnv.merge(qbxmlEnv).merge(relayMockEnv),
  migrate: commonEnv.merge(databaseEnv),
  seed: commonEnv.merge(databaseEnv).merge(seedEnv),
} as const;

export type ServiceName = keyof typeof serviceSchemas;
export type ServiceConfig<S extends ServiceName> = z.output<(typeof serviceSchemas)[S]>;

export type ApiConfig = ServiceConfig<'api'>;
export type WorkerConfig = ServiceConfig<'worker'>;
export type SyncConfig = ServiceConfig<'sync'>;
export type RelayMockConfig = ServiceConfig<'relay-mock'>;

export class ConfigError extends Error {
  readonly issues: { variable: string; message: string }[];
  constructor(service: string, issues: { variable: string; message: string }[]) {
    super(
      `Invalid configuration for ${service}:\n` +
        issues.map((i) => `  - ${i.variable}: ${i.message}`).join('\n'),
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Env = Record<string, string | undefined>;

/** Treat empty strings as unset so `FOO=` falls back to the default. */
function normalize(env: Env): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

/** Parse any Zod object schema against the environment, throwing a readable ConfigError. */
export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  env: Env = process.env,
  label = 'service',
): z.output<T> {
  const res = schema.safeParse(normalize(env));
  if (!res.success) {
    throw new ConfigError(
      label,
      res.error.issues.map((i) => ({
        variable: i.path.join('.') || '(root)',
        message: i.message === 'Required' ? 'is required' : i.message,
      })),
    );
  }
  return res.data as z.output<T>;
}

/** Load and validate the configuration for one service. */
export function loadConfig<S extends ServiceName>(
  service: S,
  env: Env = process.env,
): ServiceConfig<S> {
  return parseEnv(serviceSchemas[service], env, service) as ServiceConfig<S>;
}
