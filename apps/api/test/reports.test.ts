import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadReportsModule } from '../src/routes/reports.js';
import { bearer, createTestApp, createToken, type TestApp } from './helpers.js';

// These run when @qbv/reports has been built (its dist is present).
const available = !!(await loadReportsModule());

describe.runIf(available)('reports mounted from @qbv/reports', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ app: { reports: 'auto' } });
  });
  afterAll(async () => t?.close());

  it('lists reports filtered by the caller’s report permissions', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/reports' })).statusCode).toBe(401);
    const all = (await createToken(t.db, ['report:*'])).token;
    const res = await t.app.inject({ method: 'GET', url: '/api/reports', headers: bearer(all) });
    expect(res.statusCode, res.body).toBe(200);
    const reports = res.json().reports as { name: string }[];
    expect(reports.length).toBeGreaterThan(0);

    const none = (await createToken(t.db, ['object:*:read'])).token;
    const empty = await t.app.inject({ method: 'GET', url: '/api/reports', headers: bearer(none) });
    expect(empty.json().reports).toEqual([]);
    const denied = await t.app.inject({
      method: 'GET',
      url: `/api/reports/${reports[0]!.name}`,
      headers: bearer(none),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('runs a SQL report over the read model', async () => {
    const tok = (await createToken(t.db, ['report:*'])).token;
    const list = (
      await t.app.inject({ method: 'GET', url: '/api/reports', headers: bearer(tok) })
    ).json();
    const sqlReport = (list.reports as { name: string; source: string }[]).find(
      (r) => r.source === 'sql',
    );
    expect(sqlReport).toBeTruthy();
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/reports/${sqlReport!.name}`,
      headers: bearer(tok),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toHaveProperty('columns');
  });
});

describe.runIf(!available)('reports package not built', () => {
  it('is skipped', () => {
    expect(available).toBe(false);
  });
});
