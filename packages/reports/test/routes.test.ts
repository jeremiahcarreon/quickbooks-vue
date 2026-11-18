import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validate } from '@qbv/qbxml';
import { getCommand, type Db } from '@qbv/db';
import { createTestDatabase, type TestDatabase } from '@qbv/db/testing';
import {
  qbReportDefinitions,
  registerReportRoutes,
  reportRoutes,
  sqlReports,
} from '../src/index.js';
import { createFakeQb, type FakeQb } from './fake-worker.js';
import { seedFixtures } from './fixtures.js';

let t: TestDatabase;
let db: Db;
let qb: FakeQb;
let app: FastifyInstance;
const now = () => new Date(2024, 2, 31, 12);

/** Test auth: `x-perms` header holds comma-separated permissions; absent = anonymous. */
function permsOf(req: { headers: Record<string, unknown> }): string[] | null {
  const h = req.headers['x-perms'];
  return typeof h === 'string' ? h.split(',').filter(Boolean) : null;
}

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  await seedFixtures(db);
  qb = createFakeQb(db);
  qb.start();
  app = Fastify();
  await registerReportRoutes(app, {
    db,
    queue: qb.queue,
    events: qb.events,
    now,
    waitMs: 10_000,
    getPermissions: permsOf,
    getActor: (req) => ({
      actorType: 'user',
      actorId: String(req.headers['x-user'] ?? '') || null,
    }),
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await qb?.close();
  await t?.destroy();
});

const get = (url: string, perms?: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url,
    headers: perms === undefined ? headers : { 'x-perms': perms, ...headers },
  });

describe('GET /reports', () => {
  it('requires authentication', async () => {
    const r = await get('/reports');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: { code: 'unauthorized', message: 'Sign in required' } });
  });

  it('lists every report for report:*', async () => {
    const r = await get('/reports', 'report:*');
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      reports: { name: string; source: string; params: unknown[] }[];
      categories: string[];
    };
    expect(body.reports).toHaveLength(sqlReports.length + qbReportDefinitions().length);
    expect(body.categories).toContain('Company & Financial');
    const pnl = body.reports.find((x) => x.name === 'GeneralSummary.ProfitAndLossStandard')!;
    expect(pnl.source).toBe('qb');
    expect(pnl.params.length).toBeGreaterThan(5);
    expect(body.reports.every((x) => !('run' in x))).toBe(true);
  });

  it('filters by per-report permission; admin sees all', async () => {
    const r = await get('/reports', 'report:ar-aging-summary,object:*:read');
    expect((r.json() as { reports: { name: string }[] }).reports.map((x) => x.name)).toEqual([
      'ar-aging-summary',
    ]);
    const admin = await get('/reports', 'admin');
    expect((admin.json() as { reports: unknown[] }).reports.length).toBeGreaterThan(100);
    const none = await get('/reports', 'object:*:read');
    expect((none.json() as { reports: unknown[] }).reports).toEqual([]);
  });
});

describe('GET /reports/:name', () => {
  it('runs an SQL report', async () => {
    const r = await get('/reports/ar-aging-summary?asOf=2024-03-31', 'report:ar-aging-summary');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.status).toBe('ready');
    expect(body.totals.total).toBe(1300);
    expect(body.meta.params).toEqual({ asOf: '2024-03-31', interval: 30 });
  });

  it('checks the report permission', async () => {
    const r = await get('/reports/ar-aging-summary', 'report:ap-aging-summary');
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('forbidden');
    expect((await get('/reports/ar-aging-summary')).statusCode).toBe(401);
  });

  it('404 for unknown reports, 400 with details for bad params', async () => {
    expect((await get('/reports/nope', 'admin')).statusCode).toBe(404);
    const bad = await get('/reports/ar-aging-summary?asOf=yesterday&interval=x', 'admin');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_params');
    expect(
      bad
        .json()
        .error.details.map((d: { param: string }) => d.param)
        .sort(),
    ).toEqual(['asOf', 'interval']);
    expect((await get('/reports/ar-aging-summary?format=xml', 'admin')).statusCode).toBe(400);
  });

  it('exports CSV', async () => {
    const r = await get('/reports/open-invoices?asOf=2024-03-31&format=csv', 'report:*');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toBe('attachment; filename="open-invoices.csv"');
    const lines = r.body.split('\r\n');
    expect(lines[0]).toBe('Open Invoices');
    expect(lines).toContain('Type,Date,Num,Terms,Due Date,Aging,Open Balance');
    expect(lines).toContain('  Invoice,2024-01-01,INV-1,Net 30,2024-01-31,60,600');
  });

  it('runs a QuickBooks report through the queue with repeated query params', async () => {
    const before = qb.received.length;
    const r = await get(
      '/reports/GeneralDetail.GeneralLedger?from=2024-01-01&to=2024-01-31&account=Checking&account=Savings&txnType=Check,Deposit',
      'report:GeneralDetail.GeneralLedger',
      { 'x-user': 'user-7' },
    );
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.meta.source).toBe('qb');
    expect(body.rows.map((x: { kind: string }) => x.kind)).toEqual([
      'text',
      'data',
      'subtotal',
      'total',
    ]);
    expect(qb.received.length).toBe(before + 1);
    const xml = qb.received.at(-1)!;
    expect(validate(xml).valid).toBe(true);
    expect(xml).toMatch(
      /<ReportAccountFilter>\s*<FullName>Checking<\/FullName>\s*<FullName>Savings<\/FullName>/,
    );
    expect(xml).toMatch(
      /<TxnTypeFilter>Check<\/TxnTypeFilter>\s*<TxnTypeFilter>Deposit<\/TxnTypeFilter>/,
    );
    const cmd = await getCommand(db, body.meta.commandId);
    expect(cmd?.actor_id).toBe('user-7');

    const cached = await get(
      '/reports/GeneralDetail.GeneralLedger?from=2024-01-01&to=2024-01-31&account=Checking&account=Savings&txnType=Check,Deposit',
      'report:*',
    );
    expect(cached.json().meta.cached).toBe(true);
    expect(qb.received.length).toBe(before + 1);
  });

  it('202 pending with Retry-After, then the result via commandId', async () => {
    qb.behaviour.delayMs = 800;
    try {
      const r = await get(
        '/reports/GeneralSummary.BalanceSheetStandard?wait=50&refresh=true',
        'report:*',
      );
      expect(r.statusCode).toBe(202);
      expect(r.headers['retry-after']).toBe('2');
      const { commandId, status } = r.json();
      expect(status).toBe('pending');
      const done = await get(
        `/reports/GeneralSummary.BalanceSheetStandard?commandId=${commandId}&wait=5000`,
        'report:*',
      );
      expect(done.statusCode).toBe(200);
      expect(done.json().meta.commandId).toBe(commandId);
    } finally {
      qb.behaviour.delayMs = 0;
    }
  });

  it('maps QuickBooks errors to 502', async () => {
    qb.behaviour.error = { code: 3250, message: 'Feature not enabled' };
    try {
      const r = await get('/reports/PayrollDetail.PayrollItemDetail', 'report:*');
      expect(r.statusCode).toBe(502);
      expect(r.json().error).toMatchObject({ code: 'qb_error', details: { statusCode: 3250 } });
    } finally {
      delete qb.behaviour.error;
    }
  });

  it('works as a registered plugin under a prefix with default auth lookup', async () => {
    const app2 = Fastify();
    app2.addHook('onRequest', async (req) => {
      (req as unknown as { auth: unknown }).auth = { permissions: ['report:*'], userId: 'u2' };
    });
    await app2.register(reportRoutes, { prefix: '/api', db, now });
    const r = await app2.inject({ method: 'GET', url: '/api/reports/vendor-balance-summary' });
    expect(r.statusCode).toBe(200);
    expect(r.json().totals.balance).toBe(1250);
    await app2.close();
  });
});
