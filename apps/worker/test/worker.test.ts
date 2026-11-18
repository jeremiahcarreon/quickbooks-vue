import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testRedisUrl } from '@qbv/config/testing';
import { getCommand, getObject, updateCommand, type Db } from '@qbv/db';
import { createTestDatabase, type TestDatabase } from '@qbv/db/testing';
import { validate } from '@qbv/qbxml';
import {
  createEventBus,
  createRedis,
  createRelayQueue,
  enqueueCommand,
  Priority,
  type EventBus,
  type QbvEvent,
  type RelayQueue,
} from '@qbv/queue';
import { RelayWorker, type RelayWorkerOptions } from '../src/worker.js';
import {
  customerRet,
  FakeRelay,
  newCommand,
  nowQb,
  respond,
  sleep,
  until,
  validRequest,
} from './helpers.js';

let t: TestDatabase;
let db: Db;
let redis: ReturnType<typeof createRedis>;
const cleanups: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  redis = createRedis(testRedisUrl());
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

afterAll(async () => {
  await redis?.quit();
  await t?.destroy();
});

interface Harness {
  relay: FakeRelay;
  queue: RelayQueue;
  bus: EventBus;
  received: QbvEvent[];
  worker: RelayWorker;
  prefix: string;
}

async function harness(opts: Partial<RelayWorkerOptions> = {}, start = true): Promise<Harness> {
  const prefix = `qbvw${randomBytes(4).toString('hex')}`;
  const relay = await new FakeRelay().start();
  const queue = createRelayQueue(redis, { prefix });
  const bus = createEventBus(testRedisUrl(), { channel: `${prefix}:events` });
  const received: QbvEvent[] = [];
  await bus.subscribe((e) => received.push(e));
  const worker = new RelayWorker({
    db,
    connection: createRedis(testRedisUrl()),
    prefix,
    relay: relay.client({ timeoutMs: 2000 }),
    events: bus,
    qbxmlVersion: '16.0',
    healthIntervalMs: 50,
    cooldownMs: 150,
    ...opts,
  });
  cleanups.push(async () => {
    await worker.close(true);
    await queue.obliterate({ force: true });
    await queue.close();
    await bus.close();
    await relay.stop();
    // Every document that reached the relay passed XSD validation.
    expect(relay.invalid).toEqual([]);
    expect(relay.handlerErrors).toEqual([]);
  });
  if (start) await worker.start();
  return { relay, queue, bus, received, worker, prefix };
}

const fast = { backoff: { type: 'fixed' as const, delay: 30 } };

describe('RelayWorker', () => {
  it('processes in priority order, one at a time, with global concurrency 1', async () => {
    const h = await harness({}, false);
    let active = 0;
    let maxActive = 0;
    h.relay.handler = async (_x, info) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active--;
      return respond({
        rs: 'HostQueryRs',
        requestID: info.rqs[0]!.requestID,
        body: {
          HostRet: {
            ProductName: 'QB',
            MajorVersion: '24',
            MinorVersion: '0',
            SupportedQBXMLVersion: ['16.0'],
            IsAutomaticLogin: 'false',
            QBFileMode: 'MultiUser',
          },
        },
      });
    };
    const ids: string[] = [];
    for (const p of [
      Priority.BulkSync,
      Priority.ReportFetch,
      Priority.IncrementalSync,
      Priority.InteractiveRead,
      Priority.InteractiveWrite,
    ]) {
      const xml = validRequest('HostQueryRq', {}, { requestID: `p${p}` });
      const { command } = await enqueueCommand(db, h.queue, {
        kind: 'query',
        requestXml: xml,
        priority: p,
        actorType: 'system',
      });
      ids.push(command.id);
    }
    await h.worker.start();
    expect(await h.queue.getGlobalConcurrency()).toBe(1);
    await until(async () => {
      const rows = await Promise.all(ids.map((id) => getCommand(db, id)));
      return rows.every((r) => r?.status === 'succeeded');
    });
    expect(h.relay.requests.map((r) => r.info?.rqs[0]?.requestID)).toEqual([
      'p1',
      'p2',
      'p5',
      'p8',
      'p10',
    ]);
    expect(maxActive).toBe(1);
    await until(
      () =>
        h.received.filter((e) => e.type === 'command.updated' && e.status === 'succeeded')
          .length === 5,
    );
  });

  it('write end to end: add -> succeeded, read model updated, events on the bus', async () => {
    const h = await harness();
    h.relay.handler = () =>
      respond({
        rs: 'CustomerAddRs',
        body: { CustomerRet: customerRet('80000100-1', 'E2E Co', { created: nowQb() }) },
      });
    const body = { CustomerAdd: { Name: 'E2E Co' } };
    const { command } = await enqueueCommand(db, h.queue, {
      kind: 'add',
      rqName: 'CustomerAddRq',
      objectType: 'Customer',
      payload: body,
      requestXml: validRequest('CustomerAddRq', body),
      priority: Priority.InteractiveWrite,
      actorType: 'user',
      actorId: 'u-9',
    });
    await until(async () => (await getCommand(db, command.id))?.status === 'succeeded');
    expect(await getObject(db, 'Customer', '80000100-1')).toMatchObject({ name: 'E2E Co' });
    await until(() =>
      h.received.some((e) => e.type === 'object.changed' && e.qbId === '80000100-1'),
    );
    const statuses = h.received
      .filter((e) => e.type === 'command.updated' && e.id === command.id)
      .map((e) => (e as { status: string }).status);
    expect(statuses).toEqual(['sending', 'succeeded']);
  });

  it('retries 503s with backoff, opens the circuit, publishes relay.health, then succeeds', async () => {
    const h = await harness();
    let calls = 0;
    h.relay.handler = () => {
      calls++;
      if (calls <= 2) return { status: 503, body: { error: 'QuickBooks is not connected' } };
      return respond({
        rs: 'HostQueryRs',
        body: {
          HostRet: {
            ProductName: 'QB',
            MajorVersion: '24',
            MinorVersion: '0',
            SupportedQBXMLVersion: ['16.0'],
            IsAutomaticLogin: 'false',
            QBFileMode: 'MultiUser',
          },
        },
      });
    };
    const states: string[] = [];
    const watch = setInterval(() => states.push(h.worker.circuit.state), 5);
    const { command } = await enqueueCommand(
      db,
      h.queue,
      {
        kind: 'query',
        requestXml: validRequest('HostQueryRq', {}),
        priority: 2,
        actorType: 'system',
      },
      { jobOptions: fast },
    );
    await until(async () => (await getCommand(db, command.id))?.status === 'succeeded', 15_000);
    clearInterval(watch);
    const row = await getCommand(db, command.id);
    expect(row?.attempts).toBe(3);
    expect(states).toContain('open');
    expect(h.worker.circuit.state).toBe('closed');
    const health = h.received
      .filter((e) => e.type === 'relay.health')
      .map((e) => (e as { connected: boolean }).connected);
    expect(health[0]).toBe(true); // first poll
    expect(health).toContain(false);
    expect(health.at(-1)).toBe(true);
  });

  it('gives up after WORKER_MAX_ATTEMPTS and marks the command failed', async () => {
    const h = await harness({ maxAttempts: 2, cooldownMs: 20 });
    h.relay.handler = () => ({ status: 503, body: { error: 'QuickBooks is not connected' } });
    const { command } = await enqueueCommand(
      db,
      h.queue,
      {
        kind: 'query',
        requestXml: validRequest('HostQueryRq', {}),
        priority: 2,
        actorType: 'system',
      },
      { jobOptions: fast },
    );
    await until(async () => (await getCommand(db, command.id))?.status === 'failed', 15_000);
    const row = await getCommand(db, command.id);
    expect(row?.attempts).toBe(2);
    expect(row?.status_message).toMatch(/after 2 attempts/);
  });

  it('on startup re-queues pending commands; one left in sending is checked by query before resending', async () => {
    const h = await harness({}, false);
    const xml = validRequest('CustomerAddRq', { CustomerAdd: { Name: 'Recovered Co' } });
    const stuck = await newCommand(db, {
      kind: 'add',
      objectType: 'Customer',
      requestXml: xml,
      priority: 1,
    });
    await updateCommand(db, stuck.id, { status: 'sending' });
    const queued = await newCommand(db, {
      kind: 'query',
      requestXml: validRequest('HostQueryRq', {}),
      priority: 5,
      actorType: 'system',
    });
    h.relay.handler = (_x, info) => {
      const rq = info.rqs[0]!.name;
      if (rq === 'CustomerQueryRq') {
        return respond({
          rs: 'CustomerQueryRs',
          body: { CustomerRet: [customerRet('80000110-1', 'Recovered Co', { created: nowQb() })] },
        });
      }
      return respond({
        rs: 'HostQueryRs',
        body: {
          HostRet: {
            ProductName: 'QB',
            MajorVersion: '24',
            MinorVersion: '0',
            SupportedQBXMLVersion: ['16.0'],
            IsAutomaticLogin: 'false',
            QBFileMode: 'MultiUser',
          },
        },
      });
    };
    const report = await h.worker.start();
    expect(report.pending).toBeGreaterThanOrEqual(2);
    expect(report.interrupted).toBeGreaterThanOrEqual(1);
    await until(
      async () =>
        (await getCommand(db, stuck.id))?.status === 'succeeded' &&
        (await getCommand(db, queued.id))?.status === 'succeeded',
    );
    // The add was confirmed by query, never resent.
    expect(h.relay.sentRqs.flat()).not.toContain('CustomerAddRq');
    expect((await getCommand(db, stuck.id))?.object_id).toBe('80000110-1');
  });

  it('graceful shutdown waits for the command in flight', async () => {
    const h = await harness();
    h.relay.handler = async () => {
      await sleep(300);
      return respond({
        rs: 'HostQueryRs',
        body: {
          HostRet: {
            ProductName: 'QB',
            MajorVersion: '24',
            MinorVersion: '0',
            SupportedQBXMLVersion: ['16.0'],
            IsAutomaticLogin: 'false',
            QBFileMode: 'MultiUser',
          },
        },
      });
    };
    const { command } = await enqueueCommand(db, h.queue, {
      kind: 'query',
      requestXml: validRequest('HostQueryRq', {}),
      priority: 2,
      actorType: 'system',
    });
    await until(() => h.relay.requests.length === 1);
    expect((await getCommand(db, command.id))?.status).toBe('sending');
    await h.worker.close();
    expect((await getCommand(db, command.id))?.status).toBe('succeeded');
  });

  it('rejects an invalid document that bypassed the producer check, without sending it', async () => {
    const h = await harness();
    const bad = validRequest('CustomerQueryRq', { MaxReturned: 1 })
      .replace('<MaxReturned>', '<MaxReturnd>')
      .replace('</MaxReturned>', '</MaxReturnd>');
    expect(validate(bad).valid).toBe(false);
    const cmd = await newCommand(db, {
      kind: 'query',
      requestXml: bad,
      priority: 2,
      actorType: 'system',
    });
    await h.queue.add('command', { commandId: cmd.id }, { jobId: cmd.id, priority: 2 });
    await until(async () => (await getCommand(db, cmd.id))?.status === 'rejected');
    expect(h.relay.requests).toHaveLength(0);
  });

  it('a job that fails for good on an unexpected error leaves no command stuck in queued/sending', async () => {
    const h = await harness();
    (h.worker.processor as unknown as { process: () => Promise<never> }).process = async () => {
      throw new Error('database went away');
    };
    const cmd = await newCommand(db, {
      kind: 'query',
      requestXml: validRequest('HostQueryRq', {}),
      priority: 2,
      actorType: 'system',
    });
    await h.queue.add(
      'command',
      { commandId: cmd.id },
      { jobId: cmd.id, priority: 2, attempts: 1 },
    );
    await until(async () => (await getCommand(db, cmd.id))?.status === 'failed');
    expect((await getCommand(db, cmd.id))?.status_message).toBe('Worker error: database went away');
  });
});
