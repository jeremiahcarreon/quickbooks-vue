/**
 * Screens for SDK features outside plain Add/Mod/Query/Del/Void: live queries
 * for entities sync cannot load, merge and cleared status on detail pages,
 * the QuickBooks actions screen and the "use QuickBooks Desktop" entries.
 * Every body the UI posts is built into qbXML and validated against the XSD.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import { createMemoryHistory } from 'vue-router';
import App from '@/App.vue';
import { installPlugins } from '@/plugins';
import { createAppRouter } from '@/router';
import { setEventSourceFactory, type EventSourceLike } from '@/stores/events';
import { DESKTOP_ONLY } from '@/modules/desktop-only/features';
import { ADMIN, mockApi, type MockRequest } from './helpers/api';
import { objects } from './helpers/catalog';
import { entityList, entityMeta } from './helpers/meta';
import { xsdCheck } from './helpers/xsd';

const openES = (): EventSourceLike => {
  const es: EventSourceLike = {
    readyState: 0,
    onopen: null,
    onerror: null,
    onmessage: null,
    addEventListener() {},
    close() {},
  };
  setTimeout(() => es.onopen?.(new Event('open')), 0);
  return es;
};

function expectXsdValid(rq: string, body: unknown) {
  const res = xsdCheck({ rq, body });
  expect(res.errors, res.xml ?? '').toEqual([]);
  expect(res.valid).toBe(true);
  return res.xml!;
}

function boot() {
  const pinia = createPinia();
  const router = createAppRouter(createMemoryHistory());
  const wrapper = mount(App, {
    global: { plugins: [{ install: (app: VueApp) => installPlugins(app, router, pinia) }] },
    attachTo: document.body,
  });
  setActivePinia(pinia);
  return { router, wrapper };
}

const LIVE = { syncable: false, requiredFilters: ['PayeeEntityRef'] };
const withFlags = (e: Record<string, unknown>) =>
  e.name === 'BillToPay' ? { ...e, ...LIVE } : { ...e, syncable: true, requiredFilters: [] };

const customer = (id: string, name: string) => ({
  type: 'Customer',
  qb_id: id,
  edit_sequence: '1',
  name,
  data: { ListID: id, EditSequence: '1', Name: name, FullName: name, IsActive: 'true' },
});
const check = {
  type: 'Check',
  qb_id: 'T1',
  edit_sequence: '1',
  ref_number: '1001',
  data: { TxnID: 'T1', EditSequence: '1', RefNumber: '1001', TxnDate: '2026-11-01' },
};

let posts: MockRequest[] = [];
function api(extra: Record<string, (r: MockRequest) => unknown> = {}) {
  posts = [];
  return mockApi({
    'GET /auth/me': () => ADMIN,
    'GET /health': () => ({}),
    'GET /meta/entities': () => ({
      entities: entityList().map((e) => withFlags(e as unknown as Record<string, unknown>)),
    }),
    'GET /meta/entities/:type': (r) => {
      const m = entityMeta(r.path.split('/').pop()!);
      return { ...m, entity: withFlags(m.entity as unknown as Record<string, unknown>) };
    },
    'GET /meta/objects/:name': (r) => {
      const n = r.path.split('/').pop()!;
      return objects[n]
        ? { root: n, objects: { [n]: objects[n] } }
        : { status: 404, body: { error: { code: 'unknown_object', message: n } } };
    },
    'GET /objects/Customer': () => ({
      items: [customer('C1', 'Acme'), customer('C2', 'Beta')],
      total: 2,
    }),
    'GET /objects/Customer/C1': () => customer('C1', 'Acme'),
    'GET /objects/Check/T1': () => check,
    'GET /commands/:id': () => ({ id: 'cmd-1', status: 'queued' }),
    ...extra,
  });
}

beforeEach(() => {
  localStorage.clear();
  setEventSourceFactory(openES);
});

describe('live query for entities sync cannot load', () => {
  it('shows a filter form instead of the read-model table and posts an XSD-valid query', async () => {
    const rets = [
      {
        BillToPay: {
          TxnID: 'B1',
          TxnType: 'Bill',
          APAccountRef: { ListID: 'A1', FullName: 'Accounts Payable' },
          TxnDate: '2026-11-01',
          RefNumber: 'V-77',
          DueDate: '2026-12-01',
          AmountDue: '120.00',
        },
      },
    ];
    api({
      'POST /objects/BillToPay/live': (r) => {
        posts.push(r);
        return {
          commandId: 'cmd-live',
          type: 'BillToPay',
          items: rets,
          total: 1,
          responses: [
            {
              name: 'BillToPayQueryRs',
              statusCode: 0,
              statusSeverity: 'Info',
              statusMessage: 'Status OK',
              rets,
              retNames: ['BillToPayRet'],
            },
          ],
        };
      },
    });
    const { router, wrapper } = boot();
    await router.push('/objects/BillToPay');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="live-query"] form').exists()).toBe(true),
    );
    expect(wrapper.text()).toContain('live from QuickBooks');
    expect(wrapper.find('table').exists()).toBe(false);

    // Required filter left empty: nothing is sent.
    await wrapper.find('[data-testid="live-query"] form').trigger('submit');
    await flushPromises();
    expect(posts).toHaveLength(0);
    expect(wrapper.find('[data-field="PayeeEntityRef"] .gf-error').text()).toBe('Required');

    // Free text in the ref picker becomes { FullName }.
    const input = wrapper.find('[data-field="PayeeEntityRef"] input');
    await input.setValue('Office Supply Co');
    await input.trigger('blur');
    await wrapper.find('[data-testid="live-query"] form').trigger('submit');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ PayeeEntityRef: { FullName: 'Office Supply Co' } });
    expectXsdValid('BillToPayQueryRq', posts[0]!.body);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="live-count"]').text()).toContain('1 returned'),
    );
    expect(wrapper.text()).toContain('V-77');
    wrapper.unmount();
  });
});

describe('merge and cleared status', () => {
  it('merges a customer into another with ListMergeRq', async () => {
    api({
      'POST /objects/Customer/C1/merge': (r) => {
        posts.push(r);
        return { status: 202, body: { commandId: 'cmd-1', status: 'queued' } };
      },
    });
    const { router, wrapper } = boot();
    await router.push('/objects/Customer/C1');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="merge-open"]').exists()).toBe(true));
    await wrapper.find('[data-testid="merge-open"]').trigger('click');
    await vi.waitFor(() => expect(document.body.querySelector('#merge-into')).not.toBeNull());
    const input = document.body.querySelector<HTMLInputElement>('#merge-into')!;
    input.value = 'Beta';
    input.dispatchEvent(new Event('input'));
    await vi.waitFor(() =>
      expect(
        [...document.body.querySelectorAll('[role="option"]')].some((o) =>
          o.textContent?.includes('Beta'),
        ),
      ).toBe(true),
    );
    const option = [...document.body.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent?.includes('Beta'),
    ) as HTMLElement;
    option.click();
    await flushPromises();
    const submit = document.body.querySelector<HTMLButtonElement>('[data-testid="merge-submit"]')!;
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
    submit.click();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ into: 'C2' });
    // What the API builds from it.
    expectXsdValid('ListMergeRq', {
      ListMergeType: 'Customer',
      MergeFrom: { ListID: 'C1', EditSequence: '1' },
      MergeTo: { ListID: 'C2', EditSequence: '1' },
    });
    wrapper.unmount();
  });

  it('sets the cleared status of a check', async () => {
    api({
      'GET /meta/entities/Check': () => ({ ...entityMeta('Check') }),
      'POST /objects/Check/T1/cleared-status': (r) => {
        posts.push(r);
        return { status: 202, body: { commandId: 'cmd-1', status: 'queued' } };
      },
    });
    const { router, wrapper } = boot();
    await router.push('/objects/Check/T1');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="cleared-open"]').exists()).toBe(true),
    );
    expect(wrapper.find('[data-testid="merge-open"]').exists()).toBe(false);
    await wrapper.find('[data-testid="cleared-open"]').trigger('click');
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="cleared-submit"]')).not.toBeNull(),
    );
    document.body.querySelector<HTMLButtonElement>('[data-testid="cleared-submit"]')!.click();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ status: 'Cleared' });
    expectXsdValid('ClearedStatusModRq', {
      ClearedStatusMod: { TxnID: 'T1', ClearedStatus: 'Cleared' },
    });
    wrapper.unmount();
  });
});

describe('QuickBooks actions screen', () => {
  it('lists the SDK actions and sends one with an XSD-valid body', async () => {
    api({
      'GET /actions': () => ({
        actions: [
          {
            name: 'SpecialAccountAddRq',
            op: 'Add',
            entity: 'Account',
            permissions: ['object:Account:write'],
            allowed: true,
          },
          {
            name: 'QBCommandExecRq',
            op: 'Other',
            entity: null,
            permissions: ['admin'],
            allowed: false,
          },
        ],
      }),
      'POST /actions/SpecialAccountAddRq': (r) => {
        posts.push(r);
        return {
          commandId: 'cmd-a',
          status: 'succeeded',
          responses: [
            {
              name: 'SpecialAccountAddRs',
              statusCode: 0,
              statusSeverity: 'Info',
              statusMessage: 'Status OK',
              rets: [{ ListID: 'A9', Name: 'Undeposited Funds', AccountType: 'OtherCurrentAsset' }],
              retNames: ['AccountRet'],
            },
          ],
        };
      },
    });
    const { router, wrapper } = boot();
    await router.push('/company/actions');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="actions-list"]').text()).toContain('Special Account Add'),
    );
    expect(wrapper.find('[data-testid="actions-list"]').text()).toContain('Needs admin');

    await router.push('/company/actions/SpecialAccountAddRq');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-field="SpecialAccountAdd.SpecialAccountType"]').exists()).toBe(
        true,
      ),
    );
    wrapper
      .find('[data-field="SpecialAccountAdd.SpecialAccountType"]')
      .findComponent({ name: 'Select' })
      .vm.$emit('update:modelValue', 'UndepositedFunds');
    await flushPromises();
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.query.get('wait')).toBe('true');
    expect(posts[0]!.body).toEqual({
      SpecialAccountAdd: { SpecialAccountType: 'UndepositedFunds' },
    });
    expectXsdValid('SpecialAccountAddRq', posts[0]!.body);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="action-result"]').text()).toContain('Status OK'),
    );
    wrapper.unmount();
  });
});

describe('features only QuickBooks Desktop has', () => {
  it('appear in the nav and explain where to do them', async () => {
    api();
    const { router, wrapper } = boot();
    await router.push('/');
    await vi.waitFor(() => expect(wrapper.text()).toContain('Reconcile'));
    for (const f of DESKTOP_ONLY) expect(wrapper.text()).toContain(f.title);
    expect(DESKTOP_ONLY.map((f) => f.area)).toEqual(
      expect.arrayContaining(['Banking', 'Employees', 'Company']),
    );
    await router.push('/desktop-only/reconcile');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="desktop-only"]').text()).toContain(
        'only available in QuickBooks Desktop',
      ),
    );
    expect(wrapper.find('[data-testid="desktop-only"]').text()).toContain('Banking > Reconcile');
    wrapper.unmount();
  });
});
