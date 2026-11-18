import { randomBytes } from 'node:crypto';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testRedisUrl } from '@qbv/config/testing';
import { getObject, getSyncState, sql, type Db } from '@qbv/db';
import { createTestDatabase, type TestDatabase } from '@qbv/db/testing';
import {
  createEventBus,
  createRedis,
  createRelayQueue,
  Priority,
  type EventBus,
  type QbvEvent,
  type RelayQueue,
} from '@qbv/queue';
import { QbStatusError, SyncEngine } from '../src/engine.js';
import { LeaderLock } from '../src/lock.js';
import { planSync, type SyncUnit } from '../src/plan.js';
import { QueueQueryRunner } from '../src/runner.js';
import { SyncScheduler } from '../src/scheduler.js';
import { requestSync, syncRequestsKey } from '../src/triggers.js';
import { FakeQuickBooks, qbTime } from './helpers/fake-qb.js';
import { startFakeWorker } from './helpers/fake-worker.js';

const prefix = `qbvsync${randomBytes(4).toString('hex')}`;
const channel = `${prefix}:events`;

let t: TestDatabase;
let db: Db;
let redis: ReturnType<typeof createRedis>;
let queue: RelayQueue;
let bus: EventBus;
let worker: Worker;
let qb: FakeQuickBooks;
let engine: SyncEngine;
const seen: Array<{ rq: string | null; priority: number; payload: unknown }> = [];
const events: QbvEvent[] = [];

const plan = planSync({
  include: [
    'Customer',
    'Invoice',
    'Account',
    'Template',
    'Company',
    'PayrollItemTax',
    'PayrollItemDeduction',
  ],
});
const unit = (k: string): SyncUnit => plan.units.find((u) => u.key === k)!;

const base = new Date('2026-11-10T10:00:00Z');
const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);

function customer(i: number, modified: Date, seq = '1000') {
  return {
    ListID: `C-${i}`,
    TimeCreated: qbTime(base),
    TimeModified: qbTime(modified),
    EditSequence: seq,
    Name: `Customer ${i}`,
    FullName: `Customer ${i}`,
    IsActive: 'true',
  };
}

function invoice(i: number, modified: Date) {
  return {
    TxnID: `T-${i}`,
    TimeCreated: qbTime(base),
    TimeModified: qbTime(modified),
    EditSequence: '2000',
    TxnNumber: String(i),
    CustomerRef: { ListID: 'C-1', FullName: 'Customer 1' },
    ARAccountRef: { ListID: 'A-1', FullName: 'Accounts Receivable' },
    TemplateRef: { ListID: 'TP-1', FullName: 'Intuit Service Invoice' },
    TxnDate: '2026-11-10',
    RefNumber: `INV-${i}`,
    InvoiceLineRet: [
      {
        TxnLineID: `L-${i}-1`,
        ItemRef: { FullName: 'Consulting' },
        Desc: 'Work',
        Quantity: '2',
        Rate: '150.00',
        Amount: '300.00',
      },
      {
        TxnLineID: `L-${i}-2`,
        ItemRef: { FullName: 'Consulting' },
        Desc: 'More',
        Quantity: '1',
        Rate: '50.00',
        Amount: '50.00',
      },
    ],
  };
}

async function liveCount(type: string): Promise<number> {
  const r = await db
    .selectFrom('qb_object')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('type', '=', type)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

function expectAllRequestsValid() {
  expect(qb.invalidRequests()).toEqual([]);
  expect(qb.requests.length).toBeGreaterThan(0);
}

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  redis = createRedis(testRedisUrl());
  queue = createRelayQueue(redis, { prefix });
  bus = createEventBus(testRedisUrl(), { channel });
  await bus.subscribe((e) => events.push(e));
  qb = new FakeQuickBooks();
  worker = startFakeWorker({ db, redis, prefix, qb, events: bus, seen });
  const runner = new QueueQueryRunner(db, queue, { events: bus, timeoutMs: 30_000 });
  engine = new SyncEngine({ db, runner, events: bus, pageSize: 500, version: '16.0' });

  // QuickBooks content.
  for (let i = 1; i <= 1203; i++) qb.put('CustomerRet', customer(i, at(-60 + (i % 50))));
  for (let i = 1; i <= 3; i++) qb.put('InvoiceRet', invoice(i, at(-30 + i)));
  qb.put('AccountRet', {
    ListID: 'A-1',
    TimeCreated: qbTime(base),
    TimeModified: qbTime(at(-100)),
    EditSequence: '1',
    Name: 'Accounts Receivable',
    FullName: 'Accounts Receivable',
    IsActive: 'true',
    AccountType: 'AccountsReceivable',
  });
  qb.put('TemplateRet', {
    ListID: 'TP-1',
    TimeCreated: qbTime(base),
    TimeModified: qbTime(base),
    EditSequence: '1',
    Name: 'Intuit Service Invoice',
    IsActive: 'true',
    TemplateType: 'Invoice',
  });
  qb.put('TemplateRet', {
    ListID: 'TP-2',
    TimeCreated: qbTime(base),
    TimeModified: qbTime(base),
    EditSequence: '1',
    Name: 'Custom Estimate',
    IsActive: 'true',
    TemplateType: 'Estimate',
  });
  qb.put('CompanyRet', { IsSampleCompany: 'false', CompanyName: 'Acme Test Co' });
  qb.put('PayrollItemTaxRet', {
    ListID: 'PT-1',
    TimeCreated: qbTime(base),
    TimeModified: qbTime(at(-5)),
    EditSequence: '1',
    Name: 'Federal Withholding',
    IsActive: 'true',
  });
  qb.put('PayrollItemDeductionRet', {
    ListID: 'PD-1',
    TimeCreated: qbTime(base),
    TimeModified: qbTime(at(-5)),
    EditSequence: '1',
    Name: '401k',
    IsActive: 'true',
  });
  // Returned by the union query too, but has its own unit (not in this plan): must be ignored.
  qb.put('PayrollItemWageRet', {
    ListID: 'PW-1',
    TimeCreated: qbTime(base),
    TimeModified: qbTime(at(-5)),
    EditSequence: '1',
    Name: 'Salary',
    IsActive: 'true',
  });
});

afterAll(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  await bus?.close();
  await redis?.quit();
  await t?.destroy();
});

beforeEach(() => {
  seen.length = 0;
  events.length = 0;
});

describe('initial load', () => {
  it('pages a large list with iterators at priority 10 and stores every row', async () => {
    const res = await engine.incremental(unit('Customer'));
    expect(res).toMatchObject({ phase: 'initial', count: 1203, pages: 3 });
    expect(await liveCount('Customer')).toBe(1203);
    expect(seen.every((s) => s.priority === Priority.BulkSync)).toBe(true);

    const reqs = qb.requests.filter((r) => r.rq === 'CustomerQueryRq');
    expect(reqs.map((r) => r.iterator)).toEqual(['Start', 'Continue', 'Continue']);
    expect(reqs[0]!.xml).toContain('<MaxReturned>500</MaxReturned>');
    expect(reqs[0]!.xml).toContain('<ActiveStatus>All</ActiveStatus>');
    expect(reqs[0]!.xml).not.toContain('FromModifiedDate');

    const st = await getSyncState(db, 'Customer');
    expect(st?.status).toBe('ok');
    expect(st?.row_count).toBe(1203);
    expect(st?.last_full_sync_at).not.toBeNull();
    expect(st?.last_reconcile_at).not.toBeNull();
    // Cursor is the newest TimeModified QuickBooks returned.
    expect(new Date(st!.last_modified_cursor!).toISOString()).toBe(at(-11).toISOString());
    expect(
      events.some(
        (e) => e.type === 'sync.progress' && e.objectType === 'Customer' && e.status === 'ok',
      ),
    ).toBe(true);
    // Sync commands ask the worker not to write the Rets through.
    expect(seen[0]!.payload).toMatchObject({
      writeThrough: false,
      sync: { phase: 'initial', unit: 'Customer' },
    });
    expectAllRequestsValid();
  });

  it('asks transactions for their line items and keeps them', async () => {
    const res = await engine.incremental(unit('Invoice'));
    expect(res.count).toBe(3);
    const req = qb.requests.filter((r) => r.rq === 'InvoiceQueryRq').at(-1)!;
    expect(req.xml).toContain('<IncludeLineItems>true</IncludeLineItems>');
    const row = await getObject(db, 'Invoice', 'T-2');
    expect(row?.ref_number).toBe('INV-2');
    expect((row?.data as { InvoiceLineRet: unknown[] }).InvoiceLineRet).toHaveLength(2);
    expectAllRequestsValid();
  });

  it('loads non-paging lists, union-only entities and id-less singletons', async () => {
    await engine.incremental(unit('Account'));
    expect(await liveCount('Account')).toBe(1);
    expect(qb.requests.filter((r) => r.rq === 'AccountQueryRq').at(-1)!.xml).not.toContain(
      'MaxReturned',
    );

    await engine.incremental(unit('PayrollItemQueryRq'));
    expect(await liveCount('PayrollItemTax')).toBe(1);
    expect(await liveCount('PayrollItemDeduction')).toBe(1);
    expect(await liveCount('PayrollItemWage')).toBe(0);
    expect((await getSyncState(db, 'PayrollItemTax'))?.status).toBe('ok');

    await engine.fullLoad(unit('Company'), { phase: 'full' });
    expect((await getObject(db, 'Company', 'singleton'))?.name).toBe('Acme Test Co');
    expectAllRequestsValid();
  });
});

describe('incremental', () => {
  it('queries from cursor minus one minute at priority 5 and upserts changes', async () => {
    qb.put('CustomerRet', customer(5, at(10), '1001'));
    qb.put('CustomerRet', customer(5000, at(11)));
    const before = (await getSyncState(db, 'Customer'))!;
    const res = await engine.incremental(unit('Customer'));
    expect(res.phase).toBe('incremental');
    expect(seen.every((s) => s.priority === Priority.IncrementalSync)).toBe(true);

    const req = qb.requests.filter((r) => r.rq === 'CustomerQueryRq').at(-1)!;
    const from = new Date(new Date(before.last_modified_cursor!).getTime() - 60_000);
    expect(req.xml).toMatch(/<FromModifiedDate>[^<]+<\/FromModifiedDate>/);
    const sent = /<FromModifiedDate>([^<]+)</.exec(req.xml)![1]!;
    expect(new Date(sent).getTime()).toBe(from.getTime());
    expect(req.xml).toContain('<ActiveStatus>All</ActiveStatus>');

    expect((await getObject(db, 'Customer', 'C-5'))?.edit_sequence).toBe('1001');
    expect(await getObject(db, 'Customer', 'C-5000')).toBeDefined();
    expect(await liveCount('Customer')).toBe(1204);
    expect(
      new Date((await getSyncState(db, 'Customer'))!.last_modified_cursor!).toISOString(),
    ).toBe(at(11).toISOString());
    expect(
      events.some((e) => e.type === 'object.changed' && e.qbId === 'C-5000' && e.op === 'sync'),
    ).toBe(true);
    expectAllRequestsValid();
  });

  it('uses ModifiedDateRangeFilter for transactions', async () => {
    qb.put('InvoiceRet', invoice(4, at(20)));
    await engine.incremental(unit('Invoice'));
    const req = qb.requests.filter((r) => r.rq === 'InvoiceQueryRq').at(-1)!;
    expect(req.xml).toMatch(/<ModifiedDateRangeFilter>\s*<FromModifiedDate>/);
    expect(await liveCount('Invoice')).toBe(4);
    expectAllRequestsValid();
  });
});

describe('deletions', () => {
  it('soft-deletes objects from ListDeletedQuery and TxnDeletedQuery', async () => {
    qb.remove('CustomerRet', 'C-7', 'list', 'Customer', at(30));
    qb.remove('InvoiceRet', 'T-1', 'txn', 'Invoice', at(30));
    const res = await engine.deletions(plan.units);
    expect(res).toEqual([
      { kind: 'list', count: 1, deleted: 1 },
      { kind: 'txn', count: 1, deleted: 1 },
    ]);
    const listReq = qb.requests.find((r) => r.rq === 'ListDeletedQueryRq')!;
    expect(listReq.xml).toContain('<ListDelType>Customer</ListDelType>');
    expect(listReq.xml).toContain('<ListDelType>Account</ListDelType>');
    expect(listReq.xml).toContain('<FromDeletedDate>');
    expect(qb.requests.find((r) => r.rq === 'TxnDeletedQueryRq')!.xml).toContain(
      '<TxnDelType>Invoice</TxnDelType>',
    );
    expect(await getObject(db, 'Customer', 'C-7')).toBeUndefined();
    expect(
      (await getObject(db, 'Customer', 'C-7', { includeDeleted: true }))?.deleted_at,
    ).not.toBeNull();
    expect(await getObject(db, 'Invoice', 'T-1')).toBeUndefined();
    expect(
      events.some((e) => e.type === 'object.changed' && e.qbId === 'C-7' && e.op === 'del'),
    ).toBe(true);
    expectAllRequestsValid();
  });
});

describe('reconcile', () => {
  it('fetches missing and changed rows by id and soft-deletes extras, keeping full data', async () => {
    // Local damage: a row lost, a stale EditSequence, a ghost row QuickBooks never had.
    await db
      .deleteFrom('qb_object')
      .where('type', '=', 'Customer')
      .where('qb_id', '=', 'C-10')
      .execute();
    await db
      .updateTable('qb_object')
      .set({ edit_sequence: 'stale' })
      .where('type', '=', 'Customer')
      .where('qb_id', '=', 'C-11')
      .execute();
    await db
      .insertInto('qb_object')
      .values({
        type: 'Customer',
        qb_id: 'C-ghost',
        name: 'Ghost',
        data: sql`'{}'::jsonb`,
        synced_at: new Date('2020-01-01'),
      })
      .execute();
    // Gone from QuickBooks without a deletion record.
    qb.vanish('CustomerRet', 'C-12');

    const res = await engine.reconcile(unit('Customer'));
    expect(res).toMatchObject({ checked: 1202, refetched: 2, deleted: 2 });

    const idReqs = qb.requests.filter(
      (r) => r.rq === 'CustomerQueryRq' && r.xml.includes('IncludeRetElement'),
    );
    expect(idReqs.length).toBe(3);
    expect(idReqs[0]!.xml).toContain('<IncludeRetElement>ListID</IncludeRetElement>');
    expect(idReqs[0]!.xml).toContain('<IncludeRetElement>EditSequence</IncludeRetElement>');
    const fetch = qb.requests.filter((r) => r.rq === 'CustomerQueryRq').at(-1)!;
    expect(fetch.xml).toContain('<ListID>C-10</ListID>');
    expect(fetch.xml).toContain('<ListID>C-11</ListID>');
    expect(fetch.xml).not.toContain('MaxReturned');

    const c10 = await getObject(db, 'Customer', 'C-10');
    expect(c10?.name).toBe('Customer 10');
    expect((c10?.data as Record<string, unknown>).IsActive).toBe('true');
    expect((await getObject(db, 'Customer', 'C-11'))?.edit_sequence).toBe('1000');
    // Untouched rows keep their full data (the id-only Rets are never stored).
    expect((await getObject(db, 'Customer', 'C-20'))?.name).toBe('Customer 20');
    expect(await getObject(db, 'Customer', 'C-ghost')).toBeUndefined();
    expect(await getObject(db, 'Customer', 'C-12')).toBeUndefined();
    expect(seen.every((s) => s.priority === Priority.BulkSync)).toBe(true);
    expectAllRequestsValid();
  });
});

describe('full re-query (no modified filter)', () => {
  it('replaces the set and soft-deletes rows QuickBooks no longer returns', async () => {
    await engine.fullLoad(unit('Template'), { phase: 'full' });
    expect(await liveCount('Template')).toBe(2);
    qb.vanish('TemplateRet', 'TP-2');
    await engine.fullLoad(unit('Template'), { phase: 'full' });
    expect(await liveCount('Template')).toBe(1);
    expect((await getSyncState(db, 'Template'))?.last_modified_cursor).toBeNull();
    expectAllRequestsValid();
  });
});

describe('errors', () => {
  it('restarts a load once when an iterator Continue fails', async () => {
    await engine.reset(unit('Customer'));
    qb.failContinues = 1;
    const res = await engine.incremental(unit('Customer'));
    expect(res).toMatchObject({ phase: 'initial', count: 1202, pages: 3 });
    const starts = qb.requests.filter((r) => r.rq === 'CustomerQueryRq' && r.iterator === 'Start');
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expectAllRequestsValid();
  });

  it('records QuickBooks errors in sync_state and rethrows', async () => {
    qb.failRq.set('AccountQueryRq', { code: 3250, message: 'This feature is not enabled' });
    await expect(engine.incremental(unit('Account'))).rejects.toBeInstanceOf(QbStatusError);
    const st = await getSyncState(db, 'Account');
    expect(st?.status).toBe('error');
    expect(st?.error).toContain('3250');
    expect(
      events.some(
        (e) => e.type === 'sync.progress' && e.objectType === 'Account' && e.status === 'error',
      ),
    ).toBe(true);
    qb.failRq.delete('AccountQueryRq');
  });
});

describe('scheduler', () => {
  it('runs manual requests from the Redis list', async () => {
    const sched = new SyncScheduler({
      engine,
      plan,
      redis,
      prefix,
      intervalMs: 3_600_000,
      fullIntervalMs: 3_600_000,
      reconcileCron: '0 3 * * *',
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    await requestSync(redis, { type: 'Template', mode: 'full', requestedBy: 'user-1' }, { prefix });
    await redis.rpush(syncRequestsKey(prefix), 'not json');
    qb.put('TemplateRet', {
      ListID: 'TP-3',
      TimeCreated: qbTime(base),
      TimeModified: qbTime(base),
      EditSequence: '1',
      Name: 'New',
      IsActive: 'true',
      TemplateType: 'Invoice',
    });
    const ctrl = new AbortController();
    const reqs = await (await import('../src/triggers.js')).drainSyncRequests(redis, { prefix });
    expect(reqs).toHaveLength(1);
    const s = await sched.handleRequests(reqs, ctrl.signal);
    expect(s.ran).toEqual(['Template']);
    expect(await liveCount('Template')).toBe(2);
    expect(await redis.llen(syncRequestsKey(prefix))).toBe(0);
  });

  it('a full step runs incrementals, full re-queries and due reconciles', async () => {
    // Make Invoice reconcile due: its last reconcile is before the latest cron fire time.
    await db
      .updateTable('sync_state')
      .set({ last_reconcile_at: new Date('2020-01-01') })
      .where('type', '=', 'Invoice')
      .execute();
    const sched = new SyncScheduler({
      engine,
      plan,
      redis,
      prefix,
      intervalMs: 3_600_000,
      fullIntervalMs: 3_600_000,
      reconcileCron: '* * * * *',
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const before = qb.requests.length;
    await sched.step(new AbortController().signal);
    const rqs = qb.requests.slice(before).map((r) => r.rq);
    expect(rqs).toContain('ListDeletedQueryRq');
    expect(rqs).toContain('TxnDeletedQueryRq');
    expect(rqs).toContain('CustomerQueryRq');
    expect(rqs).toContain('TemplateQueryRq');
    expect(rqs).toContain('CompanyQueryRq');
    expect(rqs).toContain('PayrollItemQueryRq');
    // Invoice reconcile ran (id-only query).
    expect(
      qb.requests
        .slice(before)
        .some((r) => r.rq === 'InvoiceQueryRq' && r.xml.includes('IncludeRetElement')),
    ).toBe(true);
    expectAllRequestsValid();
  });

  it('stops promptly when aborted', async () => {
    const sched = new SyncScheduler({
      engine,
      plan,
      redis,
      prefix,
      intervalMs: 3_600_000,
      fullIntervalMs: 3_600_000,
      reconcileCron: '0 3 * * *',
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sched.incrementalPass(ctrl.signal)).rejects.toThrow(/aborted/);
  });
});

describe('leader lock', () => {
  it('lets one instance lead and hands over when it stops', async () => {
    const key = `${prefix}:sync:leader`;
    const a = new LeaderLock(redis, { key, ttlMs: 3000, owner: 'a' });
    const b = new LeaderLock(redis, { key, ttlMs: 3000, owner: 'b' });
    expect(await a.tick()).toBe(true);
    expect(await b.tick()).toBe(false);
    expect(await a.tick()).toBe(true); // renew
    expect(await redis.pttl(key)).toBeGreaterThan(2000);
    await a.stop();
    expect(await b.tick()).toBe(true);
    await b.stop();
    expect(await redis.exists(key)).toBe(0);
  });

  it('notices a lost lock', async () => {
    const key = `${prefix}:sync:leader2`;
    let lost = 0;
    const a = new LeaderLock(redis, { key, ttlMs: 3000, owner: 'a', onLost: () => lost++ });
    expect(await a.tick()).toBe(true);
    await redis.set(key, 'someone-else');
    expect(await a.tick()).toBe(false);
    expect(lost).toBe(1);
    await redis.del(key);
  });
});
