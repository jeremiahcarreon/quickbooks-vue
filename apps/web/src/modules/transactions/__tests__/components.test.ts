import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PrimeVue from 'primevue/config';
import LineGrid from '../components/LineGrid.vue';
import RefPicker from '../components/RefPicker.vue';
import { clearSearchCache } from '../lib/api';
import { specBySlug } from '../lib/specs';
import type { TxnLine } from '../lib/types';
import { routes } from '../index';
import { ref } from './fixtures';
import { mockApi, notFound, page } from './mockApi';
import { mountRoutes } from './mountRoutes';

afterEach(() => {
  clearSearchCache();
  document.body.innerHTML = '';
});

function mountAt(path: string) {
  return mountRoutes(routes, path);
}

describe('LineGrid', () => {
  const sales = specBySlug('invoice')!.lines[0]!;

  it('computes line totals as you type and keeps a blank line at the end', async () => {
    const lines: TxnLine[] = [{ key: 'a', values: {} }];
    const w = mount(LineGrid, {
      props: {
        section: sales,
        lineObject: 'InvoiceLineAdd',
        lines,
        'onUpdate:lines': (v: TxnLine[]) => w.setProps({ lines: v }),
      },
      global: { plugins: [PrimeVue] },
      attachTo: document.body,
    });
    await w.find('input[aria-label="Line 1 Qty"]').setValue('3');
    await w.find('input[aria-label="Line 1 Rate"]').setValue('19.99');
    const current = w.props('lines') as TxnLine[];
    expect(current[0]!.values.Amount).toBe('59.97');
    expect(w.find('.lines__total').text()).toBe('59.97');
    // A non-blank last line gets a fresh blank line after it.
    expect(current.length).toBe(2);
    // Editing the amount derives the rate.
    await w.find('input[aria-label="Line 1 Amount"]').setValue('60');
    expect((w.props('lines') as TxnLine[])[0]!.values.Rate).toBe('20');
    // Ctrl+Delete removes the focused line.
    await w.find('[data-cell="lines-r0-c2"]').trigger('keydown', { key: 'Delete', ctrlKey: true });
    expect((w.props('lines') as TxnLine[]).length).toBe(1);
    w.unmount();
  });
});

describe('Journal entry screen', () => {
  it('blocks saving until debits equal credits', async () => {
    mockApi(() => ({ status: 404, body: { error: { code: 'not_found', message: 'nope' } } }));
    const { wrapper } = await mountAt('/transactions/journal-entry/new');
    expect(wrapper.text()).toContain('Make General Journal Entries');
    const save = () => wrapper.findAll('button').find((b) => b.text() === 'Save')!;
    expect(save().attributes('disabled')).toBeDefined();
    await wrapper.find('input[aria-label="Line 1 debit"]').setValue('100');
    await wrapper.find('input[aria-label="Line 2 credit"]').setValue('60');
    expect(wrapper.text()).toContain('Out of balance');
    expect(wrapper.text()).toContain('40.00');
    expect(save().attributes('disabled')).toBeDefined();
    // Typing a credit on the debit line clears its debit.
    await wrapper.find('input[aria-label="Line 1 credit"]').setValue('5');
    expect(
      (wrapper.find('input[aria-label="Line 1 debit"]').element as HTMLInputElement).value,
    ).toBe('');
    wrapper.unmount();
  });
});

describe('Write Check screen', () => {
  it('totals lines, submits the Add body and shows pending then confirmed', async () => {
    let polls = 0;
    const calls = mockApi((method, url) => {
      if (method === 'POST' && url === '/api/objects/Check')
        return { status: 202, body: { commandId: 'cmd-1', status: 'queued' } };
      if (url === '/api/commands/cmd-1') {
        polls += 1;
        return polls < 2
          ? { status: 200, body: { id: 'cmd-1', status: 'sending' } }
          : {
              status: 200,
              body: {
                id: 'cmd-1',
                status: 'succeeded',
                statusCode: 0,
                result: { rets: [{ TxnID: 'NEW-9' }] },
              },
            };
      }
      if (url.startsWith('/api/objects/Check/NEW-9')) {
        return {
          status: 200,
          body: {
            type: 'Check',
            qb_id: 'NEW-9',
            data: {
              TxnID: 'NEW-9',
              EditSequence: '1',
              AccountRef: { ListID: 'B1', FullName: 'Checking' },
              Amount: '45.10',
            },
          },
        };
      }
      return { status: 404, body: { error: { code: 'not_found', message: 'not found' } } };
    });
    const { wrapper, router } = await mountAt('/transactions/check/new');
    expect(wrapper.text()).toContain('Write Check');

    const pickers = wrapper.findAllComponents(RefPicker);
    // Header: bank account (first picker), then expense line account.
    pickers[0]!.vm.$emit('update:modelValue', ref('Checking', 'B1'));
    const lineAccount = wrapper
      .findAllComponents(RefPicker)
      .find((p) => p.props('ariaLabel') === 'Line 1 Account')!;
    lineAccount.vm.$emit('update:modelValue', ref('Office Expense', 'A1'));
    await flushPromises();
    await wrapper.find('input[aria-label="Line 1 Amount"]').setValue('45.1');
    await flushPromises();
    expect(wrapper.text()).toContain('45.10');

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Save')!
      .trigger('click');
    await flushPromises();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({
      AccountRef: { ListID: 'B1' },
      ExpenseLineAdd: [{ AccountRef: { ListID: 'A1' }, Amount: '45.10' }],
    });
    expect(Object.keys(post!.body as object)[0]).toBe('AccountRef');
    expect(wrapper.text()).toContain('Pending');

    await vi.waitFor(
      () => expect(router.currentRoute.value.fullPath).toBe('/transactions/check/NEW-9'),
      { timeout: 3000, interval: 50 },
    );
    await flushPromises();
    expect(wrapper.text()).toContain('Confirmed');
    wrapper.unmount();
  });

  it('shows the API rejection message (e.g. schema validation) without losing the form', async () => {
    mockApi((method) =>
      method === 'POST'
        ? {
            status: 400,
            body: {
              error: {
                code: 'qbxml_invalid',
                message: "Element 'Amount': '1e5' is not a valid value",
              },
            },
          }
        : { status: 404, body: { error: { code: 'not_found', message: 'x' } } },
    );
    const { wrapper } = await mountAt('/transactions/transfer/new');
    const pickers = wrapper.findAllComponents(RefPicker);
    pickers[0]!.vm.$emit('update:modelValue', ref('Checking', 'B1'));
    pickers[1]!.vm.$emit('update:modelValue', ref('Savings', 'B2'));
    await flushPromises();
    await wrapper.find('#h-Amount').setValue('500');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Save')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Not saved.');
    expect(wrapper.text()).toContain("Element 'Amount'");
    expect((wrapper.find('#h-Amount').element as HTMLInputElement).value).toBe('500');
    wrapper.unmount();
  });
});

describe('Receive Payment screen', () => {
  it('loads open invoices, auto-applies the amount oldest first and posts the applications', async () => {
    const calls = mockApi((method, url) => {
      if (url.startsWith('/api/objects/Invoice?'))
        return page('Invoice', [
          {
            TxnID: 'I2',
            RefNumber: '1002',
            TxnDate: '2026-10-01',
            DueDate: '2026-10-31',
            BalanceRemaining: '300.00',
            Subtotal: '300.00',
          },
          {
            TxnID: 'I1',
            RefNumber: '1001',
            TxnDate: '2026-09-01',
            DueDate: '2026-10-01',
            BalanceRemaining: '200.00',
            Subtotal: '200.00',
          },
        ]);
      if (url.startsWith('/api/objects/Charge?') || url.startsWith('/api/objects/CreditMemo?'))
        return page('X', []);
      if (method === 'POST') return { status: 202, body: { commandId: 'c9' } };
      if (url === '/api/commands/c9') return { status: 200, body: { id: 'c9', status: 'queued' } };
      return notFound;
    });
    const { wrapper } = await mountAt('/transactions/receive-payment/new');
    const customer = wrapper.findAllComponents(RefPicker)[0]!;
    customer.vm.$emit('update:modelValue', ref('Acme', 'C1'));
    await vi.waitFor(() => expect(wrapper.text()).toContain('1002'));
    const invoiceQuery = calls.find((c) => c.url.startsWith('/api/objects/Invoice?'))!;
    expect(invoiceQuery.url).toContain('filter[CustomerRef.ListID]=C1');
    expect(invoiceQuery.url).toContain('filter[IsPaid]=false');

    const amount = wrapper.find('#rp-amount');
    await amount.setValue('250');
    await amount.trigger('blur');
    const pay = (n: string) =>
      (wrapper.find(`input[aria-label="Payment for ${n}"]`).element as HTMLInputElement).value;
    expect(pay('1001')).toBe('200.00');
    expect(pay('1002')).toBe('50.00');

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Save')!
      .trigger('click');
    await flushPromises();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/objects/ReceivePayment');
    expect(post.body).toEqual({
      CustomerRef: { ListID: 'C1' },
      TxnDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      TotalAmount: '250.00',
      AppliedToTxnAdd: [
        { TxnID: 'I1', PaymentAmount: '200.00' },
        { TxnID: 'I2', PaymentAmount: '50.00' },
      ],
    });
    expect(wrapper.text()).toContain('Pending');
    wrapper.unmount();
  });
});
