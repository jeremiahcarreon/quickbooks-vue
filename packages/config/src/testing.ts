/**
 * Defaults for the local test infrastructure started by `npm run infra:up`
 * (compose project `qbv-test`). Override with TEST_DATABASE_URL / TEST_REDIS_URL.
 */
export const TEST_POSTGRES_PORT = 55433;
export const TEST_REDIS_PORT = 56379;

export function testDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.TEST_DATABASE_URL || `postgres://qbv:qbv@127.0.0.1:${TEST_POSTGRES_PORT}/qbv`;
}

export function testRedisUrl(env: Record<string, string | undefined> = process.env): string {
  return env.TEST_REDIS_URL || `redis://127.0.0.1:${TEST_REDIS_PORT}/0`;
}

/** A complete environment that satisfies every service schema, for tests. */
export function testEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    RELAY_URL: 'http://127.0.0.1:9223',
    RELAY_API_KEY: 'test-relay-key',
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-0123456789',
    COOKIE_SECURE: 'false',
    ...overrides,
  };
}
