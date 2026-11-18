import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRequest, parseResponse } from '@qbv/qbxml';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMockConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { seedSampleCompany } from '../src/seed.js';
import { RelayMock } from '../src/server.js';
import { expectValid, testEngine } from './helpers.js';

describe('sample company seed', () => {
  it('is deterministic', () => {
    const a = new Engine({ clock: { now: () => new Date('2026-11-01T00:00:00Z') } });
    const b = new Engine({ clock: { now: () => new Date('2027-03-01T00:00:00Z') } });
    seedSampleCompany(a);
    seedSampleCompany(b);
    expect(JSON.stringify(a.store.snapshot())).toBe(JSON.stringify(b.store.snapshot()));
    const c = new Engine();
    seedSampleCompany(c, { seed: 7 });
    expect(JSON.stringify(c.store.snapshot())).not.toBe(JSON.stringify(a.store.snapshot()));
  });

  it('creates a believable small HVAC company', () => {
    const t = testEngine('2026-11-17T12:00:00Z');
    const summary = seedSampleCompany(t.engine);
    expect(summary.anchor).toBe('2026-10-31');
    expect(summary.transactions).toBeGreaterThanOrEqual(180);
    expect(summary.transactions).toBeLessThanOrEqual(320);
    const count = (e: string) => t.engine.store.all(e).length;
    expect(count('Account')).toBeGreaterThan(30);
    expect(count('Customer')).toBeGreaterThan(25);
    expect(count('Vendor')).toBeGreaterThan(8);
    expect(count('Employee')).toBe(6);
    expect(count('Invoice')).toBeGreaterThan(30);
    expect(count('ReceivePayment')).toBeGreaterThan(20);
    expect(count('Bill')).toBeGreaterThan(20);
    for (const e of [
      'StandardTerms',
      'SalesTaxCode',
      'ItemSalesTax',
      'ItemService',
      'ItemInventory',
      'ItemNonInventory',
      'Deposit',
      'JournalEntry',
      'BillPaymentCheck',
      'Estimate',
    ])
      expect(count(e), e).toBeGreaterThan(0);
    // Jobs under commercial customers.
    const jobs = t.rq('CustomerQueryRq', { NameFilter: { MatchCriterion: 'Contains', Name: ':' } });
    expect(jobs.rets.length).toBeGreaterThan(0);
    expect(jobs.rets.every((j) => j.Sublevel === '1')).toBe(true);
    // Transactions fall within the year before the anchor.
    const dates = t.rq('TransactionQueryRq', {}).rets.map((r) => String(r.TxnDate));
    expect(dates.every((d) => d >= '2025-10-01' && d <= '2026-10-31')).toBe(true);
    // Some invoices are still open.
    expect(t.rq('InvoiceQueryRq', { PaidStatus: 'NotPaidOnly' }).rets.length).toBeGreaterThan(0);
    // Every entity query over the seeded data returns an XSD-valid response.
    for (const e of t.engine.store.entities()) {
      const q = t.engine.entityOf(e).ops.query;
      if (!q) continue;
      const res = t.engine.processXml(buildRequest(q, {}));
      expectValid(res);
      expect(parseResponse(res)[0]!.statusCode, e).toBe(0);
    }
    expect(t.internalErrors).toEqual([]);
  });

  it('anchors at today on request', () => {
    const e = new Engine({ clock: { now: () => new Date(2027, 1, 10, 12) } });
    expect(seedSampleCompany(e, { anchor: 'today' }).anchor).toBe('2027-02-10');
  });
});

describe('persistence', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-mock-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('saves after writes and reloads on start', async () => {
    const file = path.join(dir, 'company.json');
    const m1 = new RelayMock({ dataFile: file });
    const r = await m1.handleQbxml(buildRequest('CustomerAddRq', { Name: 'Persisted Customer' }));
    expect(r.status).toBe(200);
    m1.flush();
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).format).toBe('qbv-relay-mock');
    await m1.close();
    const m2 = new RelayMock({ dataFile: file, seed: true });
    // Existing data is kept and the seed is skipped.
    expect(m2.engine.store.all('Invoice')).toHaveLength(0);
    const q = await m2.handleQbxml(
      buildRequest('CustomerQueryRq', { FullName: 'Persisted Customer' }),
    );
    expect(parseResponse(String(q.body.response))[0]!.rets).toHaveLength(1);
    await m2.close();
  });
});

describe('configuration', () => {
  it('parses the relay-mock environment with defaults', () => {
    const c = loadMockConfig({});
    expect(c).toMatchObject({
      RELAY_MOCK_PORT: 9223,
      RELAY_MOCK_HOST: '0.0.0.0',
      RELAY_API_KEY: '',
      MOCK_LATENCY_MS: 0,
      SEED: false,
      MOCK_SEED_ANCHOR: '2026-10-31',
      MOCK_REQUEST_TIMEOUT_MS: 120_000,
      MOCK_ALLOWED_IPS: [],
    });
    const d = loadMockConfig({
      SEED: '1',
      MOCK_LATENCY_MS: '250',
      MOCK_ALLOWED_IPS: '10.0.0.5, 10.0.0.6',
      MOCK_SEED_ANCHOR: 'today',
      MOCK_DATA_FILE: '/data/qb.json',
      RELAY_API_KEY: 'k',
    });
    expect(d).toMatchObject({
      SEED: true,
      MOCK_LATENCY_MS: 250,
      MOCK_ALLOWED_IPS: ['10.0.0.5', '10.0.0.6'],
      MOCK_SEED_ANCHOR: 'today',
      MOCK_DATA_FILE: '/data/qb.json',
      RELAY_API_KEY: 'k',
    });
    expect(() => loadMockConfig({ MOCK_SEED_ANCHOR: 'yesterday' })).toThrow(/MOCK_SEED_ANCHOR/);
  });
});
