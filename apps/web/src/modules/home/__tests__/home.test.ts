import { describe, expect, it, vi } from 'vitest';
import { mountRoutes } from '../../transactions/__tests__/mountRoutes';
import { mockApi, page } from '../../transactions/__tests__/mockApi';
import { fmtAmount } from '../../transactions/lib/decimal';
import { routes } from '../index';
import { bucketFor, mergeRecent, summarizeOpen } from '../lib/dashboard';
import { summarizeSync } from '../lib/sync';

const row = (type: string, data: Record<string, unknown>) => ({
  type,
  id: String(data.TxnID),
  data,
  timeModified: data.TimeModified as string | undefined,
});

describe('dashboard figures', () => {
  it('buckets by days past due', () => {
    expect(bucketFor('2026-11-17', '2026-11-17')).toBe('Current');
    expect(bucketFor('2026-11-16', '2026-11-17')).toBe('1-30');
    expect(bucketFor('2026-10-18', '2026-11-17')).toBe('1-30');
    expect(bucketFor('2026-10-17', '2026-11-17')).toBe('31-60');
    expect(bucketFor('2026-08-01', '2026-11-17')).toBe('> 90');
    expect(bucketFor(undefined, '2026-11-17')).toBe('Current');
  });

  it('sums open and overdue balances exactly', () => {
    const s = summarizeOpen(
      [
        row('Invoice', { TxnID: '1', DueDate: '2026-12-01', BalanceRemaining: '100.10' }),
        row('Invoice', { TxnID: '2', DueDate: '2026-11-01', BalanceRemaining: '0.20' }),
        row('Invoice', { TxnID: '3', DueDate: '2026-07-01', BalanceRemaining: '1000.00' }),
        row('Invoice', { TxnID: '4', DueDate: '2026-07-01', BalanceRemaining: '0.00' }),
        row('Bill', { TxnID: '5', DueDate: '2026-11-10', OpenAmount: '5.55' }),
      ],
      '2026-11-17',
    );
    expect(s.count).toBe(4);
    expect(fmtAmount(s.total)).toBe('1105.85');
    expect(s.overdueCount).toBe(3);
    expect(fmtAmount(s.overdue)).toBe('1005.75');
    expect(fmtAmount(s.aging['1-30'])).toBe('5.75');
    expect(fmtAmount(s.aging['> 90'])).toBe('1000.00');
  });

  it('merges recent activity newest first', () => {
    const r = mergeRecent(
      [
        row('Invoice', { TxnID: 'a', TimeModified: '2026-11-01T10:00:00-05:00', Subtotal: '1' }),
        row('Bill', { TxnID: 'b', TimeModified: '2026-11-03T10:00:00-05:00', AmountDue: '2' }),
        row('Check', { TxnID: 'c', TimeModified: '2026-11-02T10:00:00-05:00', Amount: '3' }),
      ],
      2,
    );
    expect(r.map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('summarises sync state', () => {
    expect(
      summarizeSync({
        items: [
          { type: 'Customer', status: 'idle', last_run_at: '2026-11-17T10:00:00Z' },
          { type: 'Invoice', status: 'error', error: 'boom', last_run_at: '2026-11-17T11:00:00Z' },
          { type: 'Bill', status: 'running' },
        ],
      }),
    ).toEqual({ types: 3, running: 1, errors: ['Invoice'], lastRun: '2026-11-17T11:00:00Z' });
    expect(summarizeSync(null).types).toBe(0);
  });
});

describe('Home screen', () => {
  it('shows receivables, payables, relay status and recent transactions', async () => {
    mockApi((_m, url) => {
      if (url.startsWith('/api/objects/Invoice?') && url.includes('IsPaid'))
        return page('Invoice', [
          { TxnID: 'I1', DueDate: '2000-01-01', BalanceRemaining: '250.00' },
        ]);
      if (url.startsWith('/api/objects/Bill?') && url.includes('IsPaid'))
        return page('Bill', [{ TxnID: 'B1', DueDate: '2999-01-01', OpenAmount: '80.00' }]);
      if (url.startsWith('/api/objects/Invoice?'))
        return page('Invoice', [
          {
            TxnID: 'I1',
            RefNumber: 'INV-1',
            TxnDate: '2026-11-01',
            TimeModified: '2026-11-01T00:00:00Z',
            Subtotal: '250',
          },
        ]);
      if (url.startsWith('/api/objects/')) return page('X', []);
      if (url === '/api/health')
        return {
          status: 200,
          body: { status: 'ok', db: 'ok', redis: 'ok', relay: { connected: true } },
        };
      if (url === '/api/admin/sync')
        return { status: 403, body: { error: { code: 'forbidden', message: 'no' } } };
      return { status: 404 };
    });
    const { wrapper: w } = await mountRoutes(routes, '/');
    await vi.waitFor(() => expect(w.text()).toContain('INV-1'));
    expect(w.text()).toContain('Open invoices');
    expect(w.text()).toContain('250.00');
    expect(w.text()).toContain('80.00');
    expect(w.text()).toContain('Connected');
    expect(w.text()).toContain('available to administrators');
    w.unmount();
  });
});
