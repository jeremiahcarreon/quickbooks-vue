import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testRedisUrl } from '@qbv/config/testing';
import { createRedis } from '@qbv/queue';
import {
  drainSyncRequests,
  parseSyncRequest,
  requestSync,
  syncRequestsKey,
} from '../src/triggers.js';
import { loadExtraConfig } from '../src/service.js';

const redis = createRedis(testRedisUrl());
const prefix = `qbvtrig${randomBytes(4).toString('hex')}`;
afterAll(async () => {
  await redis.del(syncRequestsKey(prefix));
  await redis.quit();
});

describe('manual sync requests', () => {
  it('round-trips through the Redis list, oldest first', async () => {
    const a = await requestSync(
      redis,
      { type: 'Customer', mode: 'full', requestedBy: 'u1' },
      { prefix },
    );
    await requestSync(redis, { type: '*' }, { prefix });
    await redis.rpush(syncRequestsKey(prefix), JSON.stringify({ type: 'Invoice', mode: 'bogus' }));
    const got = await drainSyncRequests(redis, { prefix });
    expect(got.map((r) => [r.type, r.mode])).toEqual([
      ['Customer', 'full'],
      ['*', 'incremental'],
    ]);
    expect(got[0]).toEqual(a);
    expect(await drainSyncRequests(redis, { prefix })).toEqual([]);
  });

  it('accepts minimal hand-written entries and rejects junk', () => {
    expect(parseSyncRequest('{"type":"Vendor"}')).toMatchObject({
      type: 'Vendor',
      mode: 'incremental',
    });
    expect(parseSyncRequest('{"type":"Vendor","mode":"reconcile"}')?.mode).toBe('reconcile');
    expect(parseSyncRequest('{"type":""}')).toBeNull();
    expect(parseSyncRequest('[1]')).toBeNull();
    expect(parseSyncRequest('nope')).toBeNull();
  });

  it('rejects unknown modes when requesting', async () => {
    await expect(
      requestSync(redis, { type: 'Customer', mode: 'x' as never }, { prefix }),
    ).rejects.toThrow(/mode/);
  });
});

describe('extra configuration', () => {
  it('has defaults and parses overrides', () => {
    expect(loadExtraConfig({})).toEqual({
      overlapMs: 60_000,
      commandTimeoutMs: 1_800_000,
      pruneResponses: true,
      includeCustomFields: true,
      lockTtlMs: 30_000,
    });
    expect(
      loadExtraConfig({
        SYNC_OVERLAP: '120',
        SYNC_PRUNE_RESPONSES: 'false',
        SYNC_COMMAND_TIMEOUT: '5m',
        SYNC_LOCK_TTL: '',
      }),
    ).toMatchObject({
      overlapMs: 120_000,
      pruneResponses: false,
      commandTimeoutMs: 300_000,
      lockTtlMs: 30_000,
    });
  });
});
