import { expect, test } from '@playwright/test';
import { Api, relayMock } from './helpers.js';

interface SyncState {
  type: string;
  status: string;
  error: string | null;
  rowCount: number | null;
}

test.describe('sync', () => {
  test('the read model mirrors every object type in QuickBooks (relay mock)', async () => {
    const api = await Api.create();
    const mock = await relayMock();

    // Ask for a full resync of everything (the admin trigger the UI uses). It
    // also realigns the read model if the relay mock was reset or reseeded.
    const trigger = await api.ctx.post('/api/admin/sync/*', {
      data: { mode: 'full' },
      headers: api.headers,
    });
    expect(trigger.status()).toBe(202);
    await expect
      .poll(
        async () => {
          const r = await api.ctx.get('/api/admin/sync');
          return ((await r.json()) as { pendingRequests: unknown[] }).pendingRequests.length;
        },
        { timeout: 30_000, message: 'the sync service picks up the request' },
      )
      .toBe(0);

    // Loads are finished and no unit is in error.
    await expect
      .poll(
        async () => {
          const res = await api.ctx.get('/api/admin/sync');
          const { states } = (await res.json()) as { states: SyncState[] };
          return states
            .filter((s) => s.status !== 'ok')
            .map((s) => `${s.type}:${s.status}:${s.error ?? ''}`);
        },
        { timeout: 60_000, message: 'every sync unit reaches ok' },
      )
      .toEqual([]);

    const res = await api.ctx.get('/api/admin/sync');
    const { states, entities } = (await res.json()) as { states: SyncState[]; entities: string[] };
    // A sync_state row exists for every entity the API considers syncable.
    const withState = new Set(states.map((s) => s.type));
    expect(entities.filter((e) => !withState.has(e))).toEqual([]);

    // Every type QuickBooks holds is in Postgres with the same number of live objects.
    const mockState = (await (await mock.get('/mock/state')).json()) as {
      objects: Record<string, number>;
    };
    const types = Object.keys(mockState.objects);
    expect(types.length).toBeGreaterThan(30);
    await expect
      .poll(
        async () => {
          const now = (await (await mock.get('/mock/state')).json()) as {
            objects: Record<string, number>;
          };
          const diffs: string[] = [];
          for (const [type, count] of Object.entries(now.objects)) {
            const page = await api.list(type, { pageSize: '1', includeInactive: 'true' });
            if (page.total !== count)
              diffs.push(`${type}: QuickBooks ${count}, read model ${page.total}`);
          }
          return diffs;
        },
        {
          timeout: 120_000,
          intervals: [2_000, 5_000, 10_000],
          message: 'read model counts match QuickBooks',
        },
      )
      .toEqual([]);

    // Spot-check content: a synced invoice carries its lines and amounts.
    const invoices = await api.list('Invoice', { pageSize: '1', sort: '-txn_date' });
    const inv = invoices.items[0]!;
    expect(inv.refNumber).toBeTruthy();
    expect(Array.isArray(inv.data.InvoiceLineRet)).toBe(true);
    expect(Number(inv.amount)).toBeGreaterThan(0);

    await mock.dispose();
    await api.dispose();
  });
});
