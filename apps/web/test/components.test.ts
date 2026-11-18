import { flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import ConflictDiff from '@/components/ConflictDiff.vue';
import LineItemsEditor from '@/components/LineItemsEditor.vue';
import MoneyInput from '@/components/MoneyInput.vue';
import ObjectForm from '@/components/ObjectForm.vue';
import ObjectView from '@/components/ObjectView.vue';
import PendingBadge from '@/components/PendingBadge.vue';
import PermissionEditor from '@/components/PermissionEditor.vue';
import QbDataTable from '@/components/QbDataTable.vue';
import RefPicker from '@/components/RefPicker.vue';
import XmlEditor from '@/components/XmlEditor.vue';
import type { FormValue } from '@/forms/model';
import { useAuthStore } from '@/stores/auth';
import { useCommandsStore, type TrackedCommand } from '@/stores/commands';
import { useEventsStore } from '@/stores/events';
import { useMetaStore } from '@/stores/meta';
import { ADMIN, mockApi } from './helpers/api';
import { entityMeta } from './helpers/meta';
import { makeRouter, mountWith } from './helpers/mount';
import { routes as entityRoutes } from '@/modules/entities';
import { entities, objects } from './helpers/catalog';

let pinia = createPinia();
beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  // signed-in admin with the full catalog in the meta store
  mockApi({ 'GET /auth/me': () => ADMIN });
  await useAuthStore().fetchMe();
  useMetaStore().seed({ entities: Object.values(entities), objects });
});
afterEach(() => vi.useRealTimers());

/** Host keeping a v-model, so emitted values flow back like in an app. */
function host(comp: unknown, props: Record<string, unknown>, initial: unknown) {
  const model = ref(initial);
  const Host = defineComponent({
    setup: () => () =>
      h(comp as never, {
        ...props,
        modelValue: model.value,
        'onUpdate:modelValue': (v: unknown) => (model.value = v),
      }),
  });
  return { Host, model };
}

describe('ObjectForm', () => {
  it('renders a CustomerAdd form with labels, required marks and nested sections', async () => {
    const { Host } = host(ObjectForm, { object: 'CustomerAdd', owner: 'Customer' }, {});
    const w = mountWith(Host, { pinia });
    const name = w.find('[data-field="Name"]');
    expect(name.text()).toContain('Name');
    expect(name.find('.gf-req').exists()).toBe(true);
    expect(name.find('input').attributes('maxlength')).toBe('41');
    expect(w.find('[data-field="BillAddress"] [data-field="BillAddress.Addr1"]').exists()).toBe(
      true,
    );
    expect(w.find('[data-field="TermsRef"] .ref-picker').exists()).toBe(true);
    w.unmount();
  });

  it('emits values on typing and shows errors by path', async () => {
    const { Host, model } = host(
      ObjectForm,
      { object: 'CustomerAdd', owner: 'Customer', errors: { 'BillAddress.City': 'Bad city' } },
      {},
    );
    const w = mountWith(Host, { pinia });
    await w.find('[data-field="Name"] input').setValue('Acme');
    await w.find('[data-field="BillAddress.City"] input').setValue('Springfield');
    expect(model.value).toMatchObject({ Name: 'Acme', BillAddress: { City: 'Springfield' } });
    expect(w.find('[data-field="BillAddress.City"] .gf-error').text()).toBe('Bad city');
    w.unmount();
  });

  it('switches choice branches (ReceivePayment: auto-apply vs applied transactions)', async () => {
    const { Host, model } = host(
      ObjectForm,
      { object: 'ReceivePaymentAdd', owner: 'ReceivePayment' },
      {},
    );
    const w = mountWith(Host, { pinia });
    expect(w.find('[data-field="IsAutoApply"]').exists()).toBe(true);
    expect(w.find('[data-field="AppliedToTxnAdd"]').exists()).toBe(false);
    const buttons = w.find('[data-choice="#c1"]').findAll('button');
    await buttons[1]!.trigger('click');
    expect((model.value as FormValue).__choice).toEqual({ c1: 1 });
    expect(w.find('[data-field="AppliedToTxnAdd"]').exists()).toBe(true);
    expect(w.find('[data-field="IsAutoApply"]').exists()).toBe(false);
    w.unmount();
  });
});

describe('LineItemsEditor', () => {
  it('adds, edits, expands and removes lines', async () => {
    const { Host, model } = host(
      LineItemsEditor,
      { object: 'InvoiceLineAdd', owner: 'Invoice', path: 'InvoiceLineAdd' },
      [],
    );
    const w = mountWith(Host, { pinia });
    const heads = w.findAll('th').map((t) => t.text());
    expect(heads).toEqual(
      expect.arrayContaining(['Item', 'Description', 'Quantity', 'Rate', 'Amount']),
    );
    await w.find('button[aria-label="Add line"], .line-items__footer button').trigger('click');
    expect(model.value).toHaveLength(1);
    const qty = w.find('input#li-InvoiceLineAdd-0-Quantity');
    await qty.setValue('3');
    expect((model.value as FormValue[])[0]!.Quantity).toBe('3');
    await w.find('button[aria-label="More fields"]').trigger('click');
    expect(
      w.find('.line-items__detail [data-field="InvoiceLineAdd[0].ServiceDate"]').exists(),
    ).toBe(true);
    await w.find('button[aria-label="Remove line"]').trigger('click');
    expect(model.value).toHaveLength(0);
    w.unmount();
  });
});

describe('MoneyInput', () => {
  it('keeps exact strings and normalises amounts on blur', async () => {
    const { Host, model } = host(MoneyInput, { kind: 'amount' }, null);
    const w = mountWith(Host, { pinia });
    const input = w.find('input');
    await input.trigger('focus');
    await input.setValue('1,234.5');
    expect(model.value).toBe('1234.5');
    await input.trigger('blur');
    expect(model.value).toBe('1234.50');
    expect((input.element as HTMLInputElement).value).toBe('1,234.50');
    w.unmount();
  });
});

describe('RefPicker', () => {
  it('searches every target type and emits { ListID, FullName } with the row', async () => {
    const api = mockApi({
      'GET /objects/StandardTerms': () => ({
        items: [
          {
            type: 'StandardTerms',
            qb_id: 'T1',
            name: 'Net 30',
            data: { ListID: 'T1', Name: 'Net 30' },
          },
        ],
        total: 1,
      }),
      'GET /objects/DateDrivenTerms': () => ({
        items: [
          {
            type: 'DateDrivenTerms',
            qb_id: 'T2',
            name: 'Net 15th',
            data: { ListID: 'T2', Name: 'Net 15th' },
          },
        ],
        total: 1,
      }),
    });
    const onSelect = vi.fn();
    const { Host, model } = host(
      RefPicker,
      { entity: ['StandardTerms', 'DateDrivenTerms'], onSelect },
      null,
    );
    const w = mountWith(Host, { pinia });
    const input = w.find('input');
    await input.setValue('net');
    await vi.waitFor(() => expect(api.calls.length).toBe(2), { timeout: 2000 });
    expect(api.calls.map((c) => `${c.path}?${c.query.get('q')}`).sort()).toEqual([
      '/objects/DateDrivenTerms?net',
      '/objects/StandardTerms?net',
    ]);
    await flushPromises();
    const options = document.querySelectorAll('.ref-picker__option');
    expect([...options].map((o) => o.textContent?.trim())).toEqual([
      'Net 15thDate Driven Terms',
      'Net 30Standard Terms',
    ]);
    (options[1]!.closest('li') as HTMLElement).click();
    await flushPromises();
    expect(model.value).toEqual({ ListID: 'T1', FullName: 'Net 30' });
    expect(onSelect.mock.calls[0]![0]).toMatchObject({ id: 'T1' });
    w.unmount();
  });

  it('keeps free text as FullName on blur', async () => {
    mockApi({ 'GET /objects/Customer': () => ({ items: [], total: 0 }) });
    const { Host, model } = host(RefPicker, { entity: 'Customer' }, null);
    const w = mountWith(Host, { pinia });
    const input = w.find('input');
    await input.setValue('Brand New Co');
    await input.trigger('blur');
    expect(model.value).toEqual({ FullName: 'Brand New Co' });
    w.unmount();
  });
});

describe('QbDataTable', () => {
  it('loads a server page with sort/search/filter params and refreshes on object.changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mockApi({
      'GET /meta/entities/Invoice': () => entityMeta('Invoice'),
      'GET /objects/Invoice': () => ({
        items: [
          {
            type: 'Invoice',
            qb_id: 'T1',
            ref_number: 'INV-1',
            name: 'Acme',
            txn_date: '2026-11-01',
            amount: '1250.00',
            data: { TxnID: 'T1', CustomerRef: { FullName: 'Acme' }, BalanceRemaining: '1250.00' },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
      }),
    });
    const onRow = vi.fn();
    const w = mountWith(QbDataTable, {
      pinia,
      props: {
        entity: 'Invoice',
        filter: { IsPaid: 'eq:false' },
        defaultSort: '-txn_date',
        onRowClick: onRow,
      },
    });
    await vi.waitFor(() => expect(w.text()).toContain('INV-1'));
    const list = api.calls.filter((c) => c.path === '/objects/Invoice');
    expect(list[0]!.query.get('sort')).toBe('-txn_date');
    expect(list[0]!.query.get('filter[IsPaid]')).toBe('eq:false');
    expect(list[0]!.query.get('pageSize')).toBe('50');
    expect(w.text()).toContain('1,250.00');

    await w.find('input[type="search"]').setValue('acme');
    await vi.advanceTimersByTimeAsync(350);
    expect(
      api.calls
        .filter((c) => c.path === '/objects/Invoice')
        .at(-1)!
        .query.get('q'),
    ).toBe('acme');

    const before = api.calls.length;
    useEventsStore().dispatch({
      type: 'object.changed',
      objectType: 'Invoice',
      qbId: 'T1',
      op: 'mod',
    });
    await vi.advanceTimersByTimeAsync(450);
    expect(api.calls.length).toBeGreaterThan(before);

    await w.find('tbody tr').trigger('click');
    expect(onRow.mock.calls[0]![0]).toMatchObject({ id: 'T1', refNumber: 'INV-1' });
    w.unmount();
  });

  it('shows optimistic rows for pending adds and badges for pending edits', async () => {
    mockApi({
      'GET /meta/entities/Customer': () => entityMeta('Customer'),
      'GET /objects/Customer': () => ({
        items: [{ type: 'Customer', qb_id: 'C1', name: 'Acme', data: { ListID: 'C1' } }],
        total: 1,
      }),
    });
    const cmds = useCommandsStore();
    cmds.track({ id: 'a1', op: 'add', entity: 'Customer', submitted: { Name: 'Pending Co' } });
    cmds.track({ id: 'm1', op: 'mod', entity: 'Customer', objectId: 'C1', status: 'sending' });
    const w = mountWith(QbDataTable, { pinia, props: { entity: 'Customer' } });
    await vi.waitFor(() => expect(w.text()).toContain('Acme'));
    expect(w.text()).toContain('Pending Co');
    expect(w.findAll('.pending-badge').map((b) => b.text())).toEqual(['Pending', 'Saving']);
    w.unmount();
  });
});

describe('ObjectView', () => {
  it('shows simple fields, refs as links and lines as a table', () => {
    const w = mountWith(ObjectView, {
      pinia,
      router: makeRouter([
        ...entityRoutes,
        { path: '/:p(.*)*', component: { template: '<div />' } },
      ]),
      props: {
        object: 'InvoiceRet',
        owner: 'Invoice',
        data: {
          TxnID: 'T1',
          RefNumber: 'INV-1',
          TxnDate: '2026-11-01',
          Subtotal: '1250.00',
          IsPaid: 'false',
          CustomerRef: { ListID: 'C1', FullName: 'Acme' },
          BillAddress: { Addr1: '1 Main St' },
          InvoiceLineRet: [
            {
              TxnLineID: 'L1',
              ItemRef: { ListID: 'I1', FullName: 'Consulting' },
              Quantity: '10',
              Amount: '1250.00',
            },
          ],
        },
      },
    });
    expect(w.find('[data-field="Subtotal"] dd').text()).toBe('1,250.00');
    expect(w.find('[data-field="IsPaid"] dd').text()).toBe('No');
    expect(w.find('[data-field="CustomerRef"] a').attributes('href')).toBe('/objects/Customer/C1');
    expect(w.find('[data-field="BillAddress"]').text()).toContain('1 Main St');
    const table = w.find('[data-field="InvoiceLineRet"] table');
    expect(table.text()).toContain('Consulting');
    expect(table.find('a').attributes('href')).toContain('/ref/I1?types=');
    w.unmount();
  });
});

describe('ConflictDiff', () => {
  it('lists submitted fields against the current object and emits reapply', async () => {
    const cmd: TrackedCommand = {
      id: 'c',
      status: 'conflict',
      op: 'mod',
      entity: 'Customer',
      objectId: 'C1',
      label: 'Edit Acme',
      submitted: { ListID: 'C1', EditSequence: '1', Phone: '555-1', Notes: '' },
      base: { ListID: 'C1', EditSequence: '1', Phone: '555-0', Notes: 'old' },
      formObject: 'CustomerMod',
      statusCode: 3200,
      statusMessage: 'out of date',
      result: { current: { ListID: 'C1', EditSequence: '2', Phone: '555-9', Notes: 'old' } },
      createdAt: 0,
      updatedAt: 0,
      dismissed: false,
    };
    const w = mountWith(ConflictDiff, { pinia, props: { command: cmd } });
    const rows = w.findAll('tbody tr').map((r) => r.findAll('td').map((d) => d.text()));
    expect(rows).toEqual([
      ['Phone', '555-0', '555-9', '555-1'],
      ['Notes', 'old', 'old', '(cleared)'],
    ]);
    expect(w.find('[data-path="Phone"]').classes()).toContain('conflict-diff__row--clash');
    await w.findAll('button').at(-1)!.trigger('click');
    expect(w.emitted('reapply')).toHaveLength(1);
    w.unmount();
  });
});

describe('PendingBadge', () => {
  it('renders nothing without a pending command', () => {
    const w = mountWith(PendingBadge, { pinia, props: { entity: 'Customer', id: 'x' } });
    expect(w.find('.pending-badge').exists()).toBe(false);
    w.unmount();
  });
});

describe('PermissionEditor', () => {
  it('toggles global and per-entity permissions', async () => {
    const { Host, model } = host(PermissionEditor, {}, ['object:*:read']);
    const w = mountWith(Host, { pinia });
    await w.find('#perm-qbxml\\:raw').trigger('change');
    expect(model.value).toEqual(['object:*:read', 'qbxml:raw']);
    const row = w.find('[data-type="Invoice"]');
    expect(row.text()).toContain('read via wildcard');
    const write = row.findAll('button').find((b) => b.text() === 'Write')!;
    await write.trigger('click');
    expect(model.value).toEqual(['object:*:read', 'object:Invoice:write', 'qbxml:raw']);
    w.unmount();
  });
});

describe('XmlEditor', () => {
  it('highlights, numbers lines, marks errors and submits on Ctrl+Enter', async () => {
    const xml = '<?qbxml version="16.0"?>\n<QBXML>\n  <Bad>&amp;</Bad>\n</QBXML>';
    const w = mountWith(XmlEditor, { pinia, props: { modelValue: xml, errorLines: [3] } });
    expect(w.find('.xml-editor__hl').html()).toContain('<span class="xml-tag">QBXML</span>');
    expect(w.findAll('.xml-editor__gutter div')).toHaveLength(4);
    expect(w.find('.xml-editor__err').text()).toBe('3');
    await w.find('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true });
    expect(w.emitted('submit')).toHaveLength(1);
    w.unmount();
  });
});
