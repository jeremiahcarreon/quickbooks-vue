import { randomBytes } from 'node:crypto';
import { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRequest, validate } from '@qbv/qbxml';
import { testRedisUrl } from '@qbv/config/testing';
import { finishCommand, getCommand, type Db } from '@qbv/db';
import { createTestDatabase, type TestDatabase } from '@qbv/db/testing';
import {
  COMMAND_JOB,
  createEventBus,
  createRedis,
  createRelayQueue,
  enqueueCommand,
  parseEvent,
  Priority,
  QbxmlRejectedError,
  reenqueuePending,
  waitForCommand,
  type EventBus,
  type QbvEvent,
  type RelayQueue,
} from '../src/index.js';

let t: TestDatabase;
let db: Db;
let redis: ReturnType<typeof createRedis>;
let queue: RelayQueue;
let bus: EventBus;
const prefix = `qbvtest${randomBytes(4).toString('hex')}`;
const channel = `${prefix}:events`;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  redis = createRedis(testRedisUrl());
  queue = createRelayQueue(redis, { prefix });
  bus = createEventBus(testRedisUrl(), { channel });
});

afterAll(async () => {
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  await bus?.close();
  await redis?.quit();
  await t?.destroy();
});

/** Build a request with @qbv/qbxml and assert it is XSD-valid. */
function validRequest(rq: string, body: object): string {
  const xml = buildRequest(rq, body);
  expect(validate(xml)).toEqual({ valid: true, errors: [] });
  return xml;
}

describe('enqueueCommand', () => {
  it('validates, stores the command and adds a prioritised job keyed by command id', async () => {
    const xml = validRequest('CustomerAddRq', { CustomerAdd: { Name: 'Queue Test' } });
    const { command, job } = await enqueueCommand(db, queue, {
      kind: 'add',
      rqName: 'CustomerAddRq',
      objectType: 'Customer',
      payload: { CustomerAdd: { Name: 'Queue Test' } },
      requestXml: xml,
      priority: Priority.InteractiveWrite,
      actorType: 'user',
      actorId: 'u1',
    });
    expect(command.status).toBe('queued');
    expect(command.priority).toBe(1);
    expect(job.id).toBe(command.id);
    expect(job.name).toBe(COMMAND_JOB);
    expect(job.data).toEqual({ commandId: command.id });
    const stored = await queue.getJob(command.id);
    expect(stored?.opts.priority).toBe(1);
    expect(stored?.opts.attempts).toBe(5);
    expect((await getCommand(db, command.id))?.request_xml).toBe(xml);
  });

  it('rejects XSD-invalid qbXML before storing or queueing anything', async () => {
    const good = validRequest('CustomerQueryRq', { MaxReturned: '5' });
    const bad = good.replace('<MaxReturned>5</MaxReturned>', '<Bogus>1</Bogus>');
    expect(validate(bad).valid).toBe(false);
    const before = await db
      .selectFrom('command')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    await expect(
      enqueueCommand(db, queue, {
        kind: 'raw',
        requestXml: bad,
        priority: Priority.InteractiveRead,
        actorType: 'token',
        actorId: 't1',
      }),
    ).rejects.toBeInstanceOf(QbxmlRejectedError);
    // element order matters: a valid element out of sequence is rejected too
    const outOfOrder = validRequest('CustomerQueryRq', {
      MaxReturned: '5',
      ActiveStatus: 'All',
    }).replace(
      /<MaxReturned>5<\/MaxReturned>(\s*)<ActiveStatus>All<\/ActiveStatus>/,
      '<ActiveStatus>All</ActiveStatus>$1<MaxReturned>5</MaxReturned>',
    );
    await expect(
      enqueueCommand(db, queue, {
        kind: 'raw',
        requestXml: outOfOrder,
        priority: 2,
        actorType: 'system',
      }),
    ).rejects.toThrow(/XSD validation/);
    const after = await db
      .selectFrom('command')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });

  it('marks the command failed when the job cannot be added', async () => {
    const broken = createRelayQueue(
      createRedis('redis://127.0.0.1:1', { lazyConnect: true, retryStrategy: () => null }),
      { prefix },
    );
    await expect(
      enqueueCommand(db, broken, { kind: 'query', priority: 5, actorType: 'system' }),
    ).rejects.toThrow();
    const last = await db
      .selectFrom('command')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(last.status).toBe('failed');
    expect(last.status_message).toMatch(/Could not enqueue/);
    await broken.close().catch(() => undefined);
  });

  it('runs higher priority (lower number) jobs first', async () => {
    const q2prefix = `${prefix}p`;
    const q2 = createRelayQueue(redis, { prefix: q2prefix });
    const order: number[] = [];
    for (const p of [
      Priority.BulkSync,
      Priority.ReportFetch,
      Priority.InteractiveWrite,
      Priority.IncrementalSync,
      Priority.InteractiveRead,
    ]) {
      await enqueueCommand(db, q2, {
        kind: 'query',
        requestXml: validRequest('CustomerQueryRq', { MaxReturned: String(p) }),
        priority: p,
        actorType: 'system',
      });
    }
    const conn = createRedis(testRedisUrl());
    await new Promise<void>((resolve) => {
      const worker = new Worker(
        'relay',
        async (job) => {
          const c = await getCommand(db, job.data.commandId);
          order.push(c!.priority);
          if (order.length === 5) setImmediate(() => void worker.close().then(resolve));
        },
        { connection: conn, prefix: q2prefix, concurrency: 1 },
      );
    });
    expect(order).toEqual([1, 2, 5, 8, 10]);
    await q2.obliterate({ force: true });
    await q2.close();
    await conn.quit();
  });

  it('re-enqueues pending commands idempotently', async () => {
    const q3 = createRelayQueue(redis, { prefix: `${prefix}r` });
    const n1 = await reenqueuePending(db, q3);
    const n2 = await reenqueuePending(db, q3);
    expect(n1).toBe(n2);
    expect(await q3.count()).toBe(n1);
    await q3.obliterate({ force: true });
    await q3.close();
  });
});

describe('events', () => {
  it('publishes and receives typed events', async () => {
    const got: QbvEvent[] = [];
    const unsub = await bus.subscribe((e) => got.push(e));
    await bus.publish({ type: 'object.changed', objectType: 'Customer', qbId: 'L1', op: 'mod' });
    await bus.publish({ type: 'relay.health', connected: false, error: 'down' });
    await redis.publish(channel, 'not json');
    await redis.publish(channel, JSON.stringify({ type: 'sync.progress', objectType: 'X' }));
    await bus.publish({
      type: 'sync.progress',
      objectType: 'Invoice',
      status: 'running',
      count: 500,
    });
    await expect.poll(() => got.length).toBe(3);
    unsub();
    expect(got.map((e) => e.type)).toEqual(['object.changed', 'relay.health', 'sync.progress']);
  });

  it('parseEvent rejects malformed messages', () => {
    expect(parseEvent('{"type":"command.updated","id":"x","status":"queued"}')).toMatchObject({
      id: 'x',
    });
    expect(parseEvent('{"type":"command.updated","id":1}')).toBeNull();
    expect(parseEvent('{"type":"nope"}')).toBeNull();
    expect(parseEvent('[]')).toBeNull();
  });
});

describe('waitForCommand', () => {
  async function newCommand() {
    const { command } = await enqueueCommand(db, queue, {
      kind: 'query',
      requestXml: validRequest('VendorQueryRq', { MaxReturned: '1' }),
      priority: Priority.InteractiveRead,
      actorType: 'system',
    });
    return command;
  }

  it('resolves on a command.updated event', async () => {
    const c = await newCommand();
    const started = Date.now();
    const wait = waitForCommand(db, c.id, { events: bus, timeoutMs: 5000, pollMs: 60_000 });
    setTimeout(async () => {
      await finishCommand(db, c.id, { status: 'succeeded', statusCode: 0 });
      await bus.publish({ type: 'command.updated', id: c.id, status: 'succeeded' });
    }, 100);
    const r = await wait;
    expect(r.done).toBe(true);
    expect(r.command?.status).toBe('succeeded');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('falls back to polling and times out with the latest row', async () => {
    const c = await newCommand();
    const polled = waitForCommand(db, c.id, { timeoutMs: 3000, pollMs: 50 });
    setTimeout(() => void finishCommand(db, c.id, { status: 'conflict', statusCode: 3200 }), 100);
    expect((await polled).command?.status).toBe('conflict');

    const c2 = await newCommand();
    const r = await waitForCommand(db, c2.id, { events: bus, timeoutMs: 200 });
    expect(r).toMatchObject({ done: false, command: { status: 'queued' } });
    expect(
      await waitForCommand(db, '00000000-0000-0000-0000-000000000000', { timeoutMs: 100 }),
    ).toEqual({
      command: undefined,
      done: false,
    });
  });
});
