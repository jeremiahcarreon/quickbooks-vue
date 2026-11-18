import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validate } from '@qbv/qbxml';
import { getCommand, type Db } from '@qbv/db';
import { createTestDatabase, type TestDatabase } from '@qbv/db/testing';
import { Priority } from '@qbv/queue';
import { ReportError, runReport, type ReportDeps } from '../src/index.js';
import { createFakeQb, type FakeQb } from './fake-worker.js';

let t: TestDatabase;
let db: Db;
let qb: FakeQb;
let deps: ReportDeps;
const now = () => new Date(2024, 1, 1, 10, 0, 0);

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  qb = createFakeQb(db);
  qb.start();
  deps = { db, queue: qb.queue, events: qb.events, now, waitMs: 10_000 };
});
afterAll(async () => {
  await qb?.close();
  await t?.destroy();
});
beforeEach(async () => {
  qb.behaviour.delayMs = 0;
  qb.behaviour.paused = false;
  delete qb.behaviour.error;
  await db.deleteFrom('report_cache').execute();
});

const PNL = 'GeneralSummary.ProfitAndLossStandard';

describe('runQbReport', () => {
  it('enqueues a validated request at report priority, parses and caches the result', async () => {
    const before = qb.received.length;
    const out = await runReport(
      deps,
      PNL,
      { from: '2024-01-01', to: '2024-01-31', ReportBasis: 'Cash' },
      {
        actorType: 'user',
        actorId: 'u1',
      },
    );
    expect(out.status).toBe('ready');
    if (out.status !== 'ready') return;
    expect(out.result.meta).toMatchObject({
      name: PNL,
      source: 'qb',
      title: 'Report ProfitAndLossStandard',
      cached: false,
      basis: 'Accrual',
    });
    expect(out.result.totals).toEqual({ c1: 'Net Income', c2: 1234.5 });
    expect(qb.received.length).toBe(before + 1);
    const xml = qb.received.at(-1)!;
    expect(validate(xml).valid).toBe(true);
    expect(xml).toContain(
      '<GeneralSummaryReportType>ProfitAndLossStandard</GeneralSummaryReportType>',
    );
    expect(xml).toContain('<FromReportDate>2024-01-01</FromReportDate>');
    expect(xml).toContain('<ReportBasis>Cash</ReportBasis>');

    const cmd = await getCommand(db, out.result.meta.commandId!);
    expect(cmd).toMatchObject({
      kind: 'report',
      rq_name: 'GeneralSummaryReportQueryRq',
      priority: Priority.ReportFetch,
      actor_type: 'user',
      actor_id: 'u1',
      status: 'succeeded',
    });
    expect(validate(cmd!.request_xml!).valid).toBe(true);

    // Second call: served from report_cache, no new QuickBooks request.
    const again = await runReport(deps, PNL, {
      to: '2024-01-31',
      from: '2024-01-01',
      ReportBasis: 'Cash',
    });
    expect(again.status === 'ready' && again.result.meta.cached).toBe(true);
    expect(qb.received.length).toBe(before + 1);
    const row = await db.selectFrom('report_cache').selectAll().executeTakeFirstOrThrow();
    expect(row.report).toBe(PNL);
    expect(row.expires_at.getTime() - row.fetched_at.getTime()).toBe(15 * 60_000);
  });

  it('refresh bypasses the cache', async () => {
    const before = qb.received.length;
    await runReport(deps, PNL, { dateMacro: 'LastMonth' });
    const r = await runReport(deps, PNL, { dateMacro: 'LastMonth' }, { refresh: true });
    expect(r.status === 'ready' && r.result.meta.cached).toBe(false);
    expect(qb.received.length).toBe(before + 2);
    expect(qb.received.at(-1)).toContain('<ReportDateMacro>LastMonth</ReportDateMacro>');
  });

  it('honours a custom TTL', async () => {
    await runReport({ ...deps, cacheTtlMs: 1000 }, 'Aging.ARAgingSummary', {});
    const row = await db.selectFrom('report_cache').selectAll().executeTakeFirstOrThrow();
    expect(row.expires_at.getTime() - row.fetched_at.getTime()).toBe(1000);
  });

  it('answers pending when QuickBooks is slow, then completes with the commandId', async () => {
    qb.behaviour.delayMs = 1500;
    const first = await runReport(deps, 'GeneralDetail.GeneralLedger', {}, { waitMs: 100 });
    expect(first.status).toBe('pending');
    if (first.status !== 'pending') return;
    // An identical request while it is in flight joins the same command.
    const joined = await runReport(deps, 'GeneralDetail.GeneralLedger', {}, { waitMs: 50 });
    expect(joined).toMatchObject({ status: 'pending', commandId: first.commandId });
    const done = await runReport(
      deps,
      'GeneralDetail.GeneralLedger',
      {},
      { commandId: first.commandId, waitMs: 10_000 },
    );
    expect(done.status).toBe('ready');
    if (done.status === 'ready') expect(done.result.meta.commandId).toBe(first.commandId);
  });

  it('a finished command nobody waited for still fills the cache', async () => {
    qb.behaviour.delayMs = 300;
    const first = await runReport(deps, 'GeneralSummary.TrialBalance', {}, { waitMs: 10 });
    expect(first.status).toBe('pending');
    await new Promise((r) => setTimeout(r, 1200));
    const before = qb.received.length;
    const later = await runReport(deps, 'GeneralSummary.TrialBalance', {});
    expect(later.status).toBe('ready');
    expect(qb.received.length).toBe(before);
  });

  it('surfaces QuickBooks errors with the status code', async () => {
    qb.behaviour.error = { code: 3250, message: 'This feature is not enabled or not available' };
    await expect(runReport(deps, 'PayrollSummary.PayrollSummary', {})).rejects.toMatchObject({
      status: 502,
      code: 'qb_error',
      details: { statusCode: 3250 },
    });
  });

  it('rejects unknown reports, bad params and foreign command ids', async () => {
    await expect(runReport(deps, 'Nope.Nothing', {})).rejects.toMatchObject({ status: 404 });
    await expect(runReport(deps, PNL, { ReportBasis: 'Vibes' })).rejects.toBeInstanceOf(
      ReportError,
    );
    await expect(
      runReport(deps, PNL, {}, { commandId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('without a queue QB reports are unavailable (503) but SQL reports still run', async () => {
    const noQueue = { db, now };
    await expect(
      runReport(noQueue, 'GeneralSummary.BalanceSheetStandard', {}),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect((await runReport(noQueue, 'ar-aging-summary', {})).status).toBe('ready');
  });
});
