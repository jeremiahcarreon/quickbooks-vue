import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  createLogger,
  loadConfig,
  parseBool,
  parseDuration,
  serviceSchemas,
} from '../src/index.js';
import { testDatabaseUrl, testEnv, testRedisUrl } from '../src/testing.js';

describe('parseDuration', () => {
  it('parses units', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('60s')).toBe(60_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('1.5s')).toBe(1500);
  });
  it('uses the default unit for bare numbers', () => {
    expect(parseDuration('60', 's')).toBe(60_000);
    expect(parseDuration('250')).toBe(250);
    expect(parseDuration(2, 'm')).toBe(120_000);
  });
  it('rejects garbage', () => {
    expect(() => parseDuration('soon')).toThrow(/Invalid duration/);
    expect(() => parseDuration(-1)).toThrow();
  });
});

describe('parseBool', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['YES', true],
    ['off', false],
    ['0', false],
  ])('%s -> %s', (input, out) => expect(parseBool(input)).toBe(out));
  it('rejects other values', () => expect(() => parseBool('maybe')).toThrow());
});

describe('loadConfig', () => {
  it('applies defaults for the worker', () => {
    const cfg = loadConfig('worker', {
      DATABASE_URL: 'postgres://u:p@db:5432/qbv',
      REDIS_URL: 'redis://redis:6379',
      RELAY_URL: 'http://relay:9123',
    });
    expect(cfg.QBXML_VERSION).toBe('16.0');
    expect(cfg.RELAY_TIMEOUT_MS).toBe(130_000);
    expect(cfg.RELAY_API_KEY).toBe('');
    expect(cfg.WORKER_MAX_ATTEMPTS).toBe(5);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.DATABASE_POOL_MAX).toBe(10);
    expect(cfg.QBXML_SCHEMA_DIR).toBeUndefined();
  });

  it('parses SYNC_INTERVAL as seconds when bare and supports units', () => {
    const base = { DATABASE_URL: 'postgres://h/db', REDIS_URL: 'redis://h' };
    expect(loadConfig('sync', base).SYNC_INTERVAL).toBe(60_000);
    expect(loadConfig('sync', { ...base, SYNC_INTERVAL: '30' }).SYNC_INTERVAL).toBe(30_000);
    expect(loadConfig('sync', { ...base, SYNC_INTERVAL: '2m' }).SYNC_INTERVAL).toBe(120_000);
    expect(
      loadConfig('sync', { ...base, SYNC_ENTITIES: 'Customer, Invoice,' }).SYNC_ENTITIES,
    ).toEqual(['Customer', 'Invoice']);
  });

  it('treats empty strings as unset', () => {
    const cfg = loadConfig('migrate', { DATABASE_URL: 'postgres://h/db', LOG_LEVEL: '' });
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  it('reports every problem in one error', () => {
    try {
      loadConfig('api', { DATABASE_URL: 'mysql://nope', SESSION_SECRET: 'short', API_PORT: 'abc' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const vars = (err as ConfigError).issues.map((i) => i.variable).sort();
      expect(vars).toEqual(['API_PORT', 'DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET']);
      expect((err as Error).message).toMatch(/REDIS_URL: is required/);
    }
  });

  it('validates QBXML_VERSION shape', () => {
    expect(() => loadConfig('relay-mock', { QBXML_VERSION: 'sixteen' })).toThrow(/QBXML_VERSION/);
    expect(loadConfig('relay-mock', {}).RELAY_MOCK_PORT).toBe(9223);
  });

  it('accepts the shared test environment for every service', () => {
    for (const name of Object.keys(serviceSchemas) as (keyof typeof serviceSchemas)[]) {
      expect(() => loadConfig(name, testEnv())).not.toThrow();
    }
    expect(testDatabaseUrl({})).toContain(':55433/');
    expect(testRedisUrl({ TEST_REDIS_URL: 'redis://x:1' })).toBe('redis://x:1');
  });

  it('seed lowercases the admin email and enforces password length', () => {
    const cfg = loadConfig('seed', {
      DATABASE_URL: 'postgres://h/db',
      ADMIN_EMAIL: ' Admin@Example.COM ',
      ADMIN_PASSWORD: 'correct horse battery',
    });
    expect(cfg.ADMIN_EMAIL).toBe('admin@example.com');
    expect(() =>
      loadConfig('seed', { DATABASE_URL: 'postgres://h/db', ADMIN_PASSWORD: 'short' }),
    ).toThrow(/ADMIN_PASSWORD/);
  });
});

describe('createLogger', () => {
  it('writes JSON with service and redacts secrets', () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger({ service: 'test', level: 'info', destination });
    log.info({ password: 'hunter2', req: { headers: { authorization: 'Bearer x' } } }, 'hello');
    const rec = JSON.parse(lines[0]!);
    expect(rec.service).toBe('test');
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('hello');
    expect(rec.password).toBe('[redacted]');
    expect(rec.req.headers.authorization).toBe('[redacted]');
  });
});
