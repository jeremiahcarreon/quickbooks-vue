import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueryError, searchObjects, upsertObjects, type Db } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

let t: TestDatabase;
let db: Db;

const ALL = ['Customer', 'Vendor', 'Invoice', 'Bill'];

function cust(id: string, fullName: string, extra: Record<string, unknown> = {}) {
  return {
    ListID: id,
    EditSequence: '1',
    Name: fullName.split(':').at(-1),
    FullName: fullName,
    IsActive: 'true',
    ...extra,
  };
}

function inv(id: string, ref: string, date: string, customerId: string, name: string, amt: string) {
  return {
    TxnID: id,
    EditSequence: '1',
    RefNumber: ref,
    TxnDate: date,
    CustomerRef: { ListID: customerId, FullName: name },
    Subtotal: amt,
    BalanceRemaining: amt,
  };
}

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  await upsertObjects(db, 'Customer', [
    cust('C1', 'Acme Heating', { CompanyName: 'Acme Heating LLC', Email: 'ap@acme.test' }),
    cust('C1J', 'Acme Heating:Warehouse Retrofit'),
    cust('C2', 'Bolt Cooling'),
    cust('C3', 'Acme Old', { IsActive: 'false' }),
  ]);
  await upsertObjects(db, 'Vendor', [
    { ListID: 'V1', EditSequence: '1', Name: 'Acme Supply', IsActive: 'true' },
  ]);
  await upsertObjects(db, 'Invoice', [
    inv('I1', '1001', '2026-01-10', 'C1', 'Acme Heating', '500.00'),
    inv('I2', '1002', '2026-02-15', 'C1J', 'Acme Heating:Warehouse Retrofit', '1500.00'),
    inv('I3', '1003', '2026-02-20', 'C2', 'Bolt Cooling', '75.00'),
  ]);
  await upsertObjects(db, 'Bill', [
    {
      TxnID: 'B1',
      EditSequence: '1',
      RefNumber: 'ACME-77',
      TxnDate: '2026-02-01',
      VendorRef: { ListID: 'V1', FullName: 'Acme Supply' },
      AmountDue: '320.00',
    },
  ]);
});
afterAll(async () => {
  await t?.destroy();
});

const byType = (r: Awaited<ReturnType<typeof searchObjects>>) =>
  Object.fromEntries(r.groups.map((g) => [g.type, g]));

describe('searchObjects', () => {
  it('groups prefix matches by type, with counts', async () => {
    const r = byType(await searchObjects(db, { q: 'acm', allowedTypes: ALL }));
    expect(r.Customer?.total).toBe(2); // inactive "Acme Old" excluded
    expect(r.Customer?.items.map((i) => i.qbId).sort()).toEqual(['C1', 'C1J']);
    expect(r.Vendor?.total).toBe(1);
    expect(r.Bill?.items[0]?.entityName).toBe('Acme Supply');
    // Transactions carry their customer's name, so Acme's invoices match too.
    expect(r.Invoice?.items.map((i) => i.qbId).sort()).toEqual(['I1', 'I2']);
  });

  it('only searches allowed types', async () => {
    const r = byType(await searchObjects(db, { q: 'acme', allowedTypes: ['Vendor'] }));
    expect(Object.keys(r)).toEqual(['Vendor']);
  });

  it('returns facet counts for unselected types but hits only for selected ones', async () => {
    const r = byType(await searchObjects(db, { q: 'acme', allowedTypes: ALL, types: ['Vendor'] }));
    expect(r.Customer?.total).toBe(2);
    expect(r.Customer?.items).toEqual([]);
    expect(r.Vendor?.items).toHaveLength(1);
  });

  it('includes inactive objects on request', async () => {
    const r = byType(
      await searchObjects(db, { q: 'acme', allowedTypes: ALL, includeInactive: true }),
    );
    expect(r.Customer?.total).toBe(3);
  });

  it('filters by customer, including its jobs and their transactions', async () => {
    const r = byType(await searchObjects(db, { entityId: 'C1', allowedTypes: ALL }));
    expect(r.Invoice?.items.map((i) => i.qbId).sort()).toEqual(['I1', 'I2']);
    expect(r.Customer?.items.map((i) => i.qbId).sort()).toEqual(['C1', 'C1J']);
    expect(r.Bill).toBeUndefined();
  });

  it('filters by date range and amount', async () => {
    const r = byType(
      await searchObjects(db, {
        allowedTypes: ALL,
        dateFrom: '2026-02-01',
        dateTo: '2026-02-28',
        amountMin: '100',
      }),
    );
    expect(r.Invoice?.items.map((i) => i.qbId)).toEqual(['I2']);
    expect(r.Customer).toBeUndefined(); // lists have no date
  });

  it('caps hits per type but keeps the full count', async () => {
    const r = byType(await searchObjects(db, { entityId: 'C1', allowedTypes: ALL, perType: 1 }));
    expect(r.Invoice?.items).toHaveLength(1);
    expect(r.Invoice?.total).toBe(2);
    expect(r.Invoice?.items[0]?.qbId).toBe('I2'); // newest first without text
  });

  it('rejects an empty query and bad filter values', async () => {
    await expect(searchObjects(db, { allowedTypes: ALL })).rejects.toBeInstanceOf(QueryError);
    await expect(
      searchObjects(db, { q: 'a', allowedTypes: ALL, dateFrom: '02/01/2026' }),
    ).rejects.toBeInstanceOf(QueryError);
    await expect(
      searchObjects(db, { q: 'a', allowedTypes: ALL, amountMin: '1e9' }),
    ).rejects.toBeInstanceOf(QueryError);
  });
});
