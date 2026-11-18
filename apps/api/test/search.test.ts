import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertObjects } from '@qbv/db';
import { catalog } from '@qbv/qbxml';
import {
  bearer,
  createTestApp,
  createToken,
  sampleRet,
  userSession,
  type Session,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let acct: Session;

beforeAll(async () => {
  t = await createTestApp();
  acct = await userSession(t, { roles: ['Accountant'] });
  await upsertObjects(t.db, catalog.entities.Customer!, [
    sampleRet('Customer', { ListID: 'S-C1', Name: 'Zephyr Air', FullName: 'Zephyr Air' }),
  ]);
  await upsertObjects(t.db, catalog.entities.Vendor!, [
    sampleRet('Vendor', { ListID: 'S-V1', Name: 'Zephyr Parts', FullName: 'Zephyr Parts' }),
  ]);
  await upsertObjects(t.db, catalog.entities.Invoice!, [
    sampleRet('Invoice', {
      TxnID: 'S-I1',
      RefNumber: 'Z-1',
      TxnDate: '2026-03-01',
      CustomerRef: { ListID: 'S-C1', FullName: 'Zephyr Air' },
      Subtotal: '250.00',
    }),
  ]);
});
afterAll(async () => t?.close());

const get = (s: Session, url: string) =>
  t.app.inject({ method: 'GET', url, headers: s.headers(false) });

describe('GET /api/search', () => {
  it('requires authentication', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/search?q=zephyr' });
    expect(res.statusCode).toBe(401);
  });

  it('groups hits by type with category and totals', async () => {
    const res = await get(acct, '/api/search?q=zeph');
    expect(res.statusCode).toBe(200);
    const groups = res.json().groups as { type: string; category: string; total: number }[];
    const types = Object.fromEntries(groups.map((g) => [g.type, g]));
    expect(types.Customer).toMatchObject({ category: 'list', total: 1 });
    expect(types.Vendor).toMatchObject({ category: 'list', total: 1 });
    expect(types.Invoice).toMatchObject({ category: 'txn', total: 1 });
  });

  it('applies type and customer filters', async () => {
    const res = await get(acct, '/api/search?types=Invoice&entity=S-C1');
    const groups = res.json().groups as { type: string; items: { qbId: string }[] }[];
    const inv = groups.find((g) => g.type === 'Invoice');
    expect(inv?.items.map((i) => i.qbId)).toEqual(['S-I1']);
    expect(groups.find((g) => g.type === 'Customer')?.items).toEqual([]);
  });

  it('only returns types the caller can read', async () => {
    const { token } = await createToken(t.db, ['object:Vendor:read']);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/search?q=zephyr',
      headers: bearer(token),
    });
    expect(res.json().groups.map((g: { type: string }) => g.type)).toEqual(['Vendor']);
  });

  it('rejects a search with no text or filter', async () => {
    const res = await get(acct, '/api/search');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_query');
  });
});
