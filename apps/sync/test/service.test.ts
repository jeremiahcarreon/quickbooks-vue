import { randomBytes } from 'node:crypto';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@qbv/config';
import { testEnv, testRedisUrl } from '@qbv/config/testing';
import { getSyncState } from '@qbv/db';
import { createTestDatabase, type TestDatabase } from '@qbv/db/testing';
import { createRedis } from '@qbv/queue';
import { createSyncService, loadExtraConfig, type SyncService } from '../src/service.js';
import { requestSync } from '../src/triggers.js';
import { FakeQuickBooks, qbTime } from './helpers/fake-qb.js';
import { startFakeWorker } from './helpers/fake-worker.js';

const prefix = `qbvsvc${randomBytes(4).toString('hex')}`;
const silent = { info() {}, warn() {}, error() {}, debug() {} };
let t: TestDatabase;
let svc: SyncService;
let standby: SyncService;
let worker: Worker;
const redis = createRedis(testRedisUrl());
const qb = new FakeQuickBooks();

async function until(fn: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

beforeAll(async () => {
  t = await createTestDatabase();
  const config = loadConfig(
    'sync',
    testEnv({
      DATABASE_URL: t.url,
      QUEUE_PREFIX: prefix,
      SYNC_ENTITIES: 'Customer,Template',
      SYNC_INTERVAL: '3600',
      SYNC_FULL_INTERVAL: '3600',
    }),
  );
  const extra = { ...loadExtraConfig({}), lockTtlMs: 1500 };
  svc = await createSyncService(config, silent, extra);
  standby = await createSyncService(config, silent, extra);
  worker = startFakeWorker({ db: svc.db, redis, prefix, qb, events: svc.events });
  qb.put('CustomerRet', {
    ListID: 'C-1',
    TimeModified: qbTime(new Date('2026-11-10T10:00:00Z')),
    EditSequence: '1',
    Name: 'A',
    FullName: 'A',
  });
  qb.put('TemplateRet', {
    ListID: 'TP-1',
    TimeModified: qbTime(new Date('2026-11-10T10:00:00Z')),
    EditSequence: '1',
    Name: 'T',
  });
});

afterAll(async () => {
  await worker?.close();
  await svc?.stop();
  await standby?.stop();
  await redis.quit();
  await t?.destroy();
});

describe('sync service', () => {
  it('plans only the configured entities', () => {
    expect(svc.plan.units.map((u) => u.key)).toEqual(['Customer', 'Template']);
  });

  it('one leader runs the schedule; a standby takes over when it stops', async () => {
    svc.scheduler.start();
    await until(async () => svc.lock.isLeader);
    standby.scheduler.start();
    await until(async () => (await getSyncState(svc.db, 'Customer'))?.status === 'ok');
    await until(async () => (await getSyncState(svc.db, 'Template'))?.status === 'ok');
    expect(standby.lock.isLeader).toBe(false);

    // Manual request, picked up by the running loop.
    qb.put('CustomerRet', {
      ListID: 'C-2',
      TimeModified: qbTime(new Date('2026-11-10T10:05:00Z')),
      EditSequence: '1',
      Name: 'B',
      FullName: 'B',
    });
    await requestSync(redis, { type: 'Customer', mode: 'incremental' }, { prefix });
    await until(async () => (await getSyncState(svc.db, 'Customer'))?.row_count === 2);

    await svc.scheduler.stop();
    await until(async () => standby.lock.isLeader, 10_000);
    expect(qb.invalidRequests()).toEqual([]);
  });
});
