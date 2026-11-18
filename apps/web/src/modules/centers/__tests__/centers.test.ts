import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountRoutes } from '../../transactions/__tests__/mountRoutes';
import { mockApi, notFound, page } from '../../transactions/__tests__/mockApi';
import { routes } from '../index';
import {
  actionPath,
  CENTERS,
  entityBalance,
  entityTransactions,
  sortTxns,
  txnSummary,
  typeLabel,
} from '../lib/centers';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('center helpers', () => {
  it('summarises transactions of every kind', () => {
    expect(
      txnSummary({
        type: 'Invoice',
        id: 'I1',
        data: {
          RefNumber: '1001',
          TxnDate: '2026-11-01',
          DueDate: '2026-12-01',
          Subtotal: '100',
          SalesTaxTotal: '8.25',
          BalanceRemaining: '58.25',
        },
      }),
    ).toMatchObject({
      number: '1001',
      amount: '108.25',
      open: '58.25',
      path: '/transactions/invoice/I1',
    });
    expect(
      txnSummary({ type: 'Bill', id: 'B1', data: { AmountDue: '40', OpenAmount: '0' } }),
    ).toMatchObject({ amount: '40.00', open: '0.00' });
    expect(
      txnSummary({ type: 'BillPaymentCheck', id: 'P', data: { Amount: '5' } }).path,
    ).toBeNull();
    expect(
      txnSummary({ type: 'ReceivePayment', id: 'R', data: { TotalAmount: '9.5' } }).open,
    ).toBeUndefined();
  });

  it('sorts newest first and labels types', () => {
    const s = sortTxns([
      { type: 'Invoice', id: '1', date: '2026-01-01', amount: '1', path: null },
      { type: 'Bill', id: '2', date: '2026-03-01', amount: '1', path: null },
    ]);
    expect(s.map((x) => x.id)).toEqual(['2', '1']);
    expect(typeLabel('SalesReceipt')).toBe('Sales Receipt');
    expect(typeLabel('Charge')).toBe('Statement Charge');
  });

  it('quick actions carry the selected entity', () => {
    const inv = CENTERS.customer.actions[0]!;
    expect(actionPath(inv, 'C 1')).toBe('/transactions/invoice/new?entity=C%201');
    const pay = CENTERS.vendor.actions.find((a) => a.label === 'Pay bills')!;
    expect(actionPath(pay, 'V1')).toBe('/transactions/pay-bills');
    expect(
      entityBalance({ type: 'Customer', id: 'c', data: { Balance: '5', TotalBalance: '12.5' } }),
    ).toBe('12.50');
  });

  it("loads one entity's history across types and reports failures", async () => {
    const calls = mockApi((_m, url) => {
      if (url.startsWith('/api/objects/Invoice?'))
        return page('Invoice', [{ TxnID: 'I1', TxnDate: '2026-02-01', Subtotal: '10' }]);
      if (url.startsWith('/api/objects/ReceivePayment?'))
        return page('ReceivePayment', [{ TxnID: 'P1', TxnDate: '2026-03-01', TotalAmount: '10' }]);
      if (url.startsWith('/api/objects/Estimate?'))
        return { status: 403, body: { error: { code: 'forbidden', message: 'no' } } };
      return page('X', []);
    });
    const res = await entityTransactions(CENTERS.customer, 'C1');
    expect(res.items.map((t) => t.id)).toEqual(['P1', 'I1']);
    expect(res.failed).toEqual(['Estimate']);
    expect(calls[0]!.url).toContain('filter[entity_ref_id]=C1');
    expect(calls[0]!.url).toContain('sort=-txn_date');
  });
});

describe('Customer Center screen', () => {
  it('lists customers, shows the selected one with balance, actions and transactions', async () => {
    mockApi((_m, url) => {
      if (url.startsWith('/api/objects/Customer?'))
        return page('Customer', [
          {
            ListID: 'C1',
            FullName: 'Acme',
            TotalBalance: '1500.00',
            Phone: '555-0100',
            BillAddress: { Addr1: '1 Main', City: 'Springfield' },
          },
          { ListID: 'C2', FullName: 'Beta', TotalBalance: '0.00' },
        ]);
      if (url.startsWith('/api/objects/Invoice?'))
        return page('Invoice', [
          {
            TxnID: 'I9',
            RefNumber: 'INV-9',
            TxnDate: '2026-11-02',
            Subtotal: '1500',
            BalanceRemaining: '1500',
          },
        ]);
      if (url.startsWith('/api/objects/')) return page('X', []);
      return notFound;
    });
    const { wrapper: w, router } = await mountRoutes(routes, '/centers/customers');
    await vi.waitFor(() => expect(w.text()).toContain('Beta'));
    await w
      .findAll('li[role="option"]')
      .find((li) => li.text().includes('Acme'))!
      .trigger('click');
    await vi.waitFor(() => expect(w.text()).toContain('INV-9'));
    expect(router.currentRoute.value.fullPath).toBe('/centers/customers/C1');
    expect(w.text()).toContain('1,500.00');
    expect(w.text()).toContain('555-0100');
    const links = w.findAll('nav[aria-label="Quick actions"] a').map((a) => a.attributes('href'));
    expect(links).toContain('/transactions/invoice/new?entity=C1');
    // Arrow keys move through the list.
    await w.find('ul[role="listbox"]').trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/centers/customers/C2');
    w.unmount();
  });
});
