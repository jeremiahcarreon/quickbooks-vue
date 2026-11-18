/**
 * Generic entity screens end to end in the browser app (mocked API): the
 * bodies the forms post are turned into qbXML with @qbv/qbxml and validated
 * against the XSD.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import { createMemoryHistory } from 'vue-router';
import App from '@/App.vue';
import { installPlugins } from '@/plugins';
import { createAppRouter } from '@/router';
import { setEventSourceFactory, useEventsStore, type EventSourceLike } from '@/stores/events';
import { ADMIN, mockApi, type MockRequest } from './helpers/api';
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

const customerRet = {
  ListID: 'C1',
  EditSequence: '1',
  Name: 'Acme',
  FullName: 'Acme',
  IsActive: 'true',
  Phone: '555-0100',
  BillAddress: { Addr1: '1 Main St', City: 'Springfield' },
  TimeModified: '2026-11-01T10:00:00-05:00',
};
const row = (data: Record<string, unknown>) => ({
  type: 'Customer',
  qb_id: data.ListID,
  edit_sequence: data.EditSequence,
  name: data.Name,
  data,
});

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

const commandRows: Record<string, Record<string, unknown>> = {};
let posts: MockRequest[] = [];

function api(extra: Record<string, (r: MockRequest) => unknown> = {}) {
  posts = [];
  return mockApi({
    'GET /auth/me': () => ADMIN,
    'GET /health': () => ({}),
    'GET /meta/entities': () => entityList(),
    'GET /meta/entities/Customer': () => entityMeta('Customer'),
    'GET /objects/Customer': () => ({ items: [row(customerRet)], total: 1 }),
    'GET /objects/Customer/C1': () => row(customerRet),
    'GET /objects/Customer/C2': () => row({ ...customerRet, ListID: 'C2', Name: 'Beta' }),
    'GET /commands/:id': (r) =>
      commandRows[r.path.split('/').pop()!] ?? {
        status: 404,
        body: { error: { code: 'nf', message: 'nf' } },
      },
    ...extra,
  });
}

beforeEach(() => {
  localStorage.clear();
  setEventSourceFactory(openES);
  for (const k of Object.keys(commandRows)) delete commandRows[k];
});

describe('generic add form', () => {
  it('validates on the client, posts an XSD-valid body and opens the new object when QuickBooks confirms', async () => {
    api({
      'POST /objects/Customer': (r) => {
        posts.push(r);
        commandRows['cmd-1'] = { id: 'cmd-1', status: 'queued' };
        return { status: 202, body: { commandId: 'cmd-1' } };
      },
    });
    const { router, wrapper } = boot();
    await router.push('/objects/Customer/new');
    await vi.waitFor(() => expect(wrapper.find('[data-field="Name"] input').exists()).toBe(true));

    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(posts).toHaveLength(0);
    expect(wrapper.find('[data-field="Name"] .gf-error').text()).toBe('Required');

    await wrapper.find('[data-field="Name"] input').setValue('New Co & Sons');
    await wrapper.find('[data-field="BillAddress.City"] input').setValue('Chicago');
    await wrapper.find('[data-field="CreditLimit"] input').setValue('2500.5');
    await wrapper.find('[data-field="CreditLimit"] input').trigger('blur');
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({
      Name: 'New Co & Sons',
      BillAddress: { City: 'Chicago' },
      CreditLimit: '2500.50',
    });
    expect(posts[0]!.headers['X-CSRF-Token']).toBe('csrf-1');
    const xml = expectXsdValid('CustomerAddRq', posts[0]!.body);
    expect(xml).toContain('<Name>New Co &amp; Sons</Name>');

    await vi.waitFor(() => expect(wrapper.text()).toContain('Waiting for QuickBooks'));
    commandRows['cmd-1'] = { id: 'cmd-1', status: 'succeeded', object_id: 'C2', status_code: 0 };
    useEventsStore().dispatch({ type: 'command.updated', id: 'cmd-1', status: 'succeeded' });
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/objects/Customer/C2'));
    await vi.waitFor(() => expect(wrapper.text()).toContain('Beta'));
    wrapper.unmount();
  });

  it('shows server validation errors on the matching field', async () => {
    api({
      'POST /objects/Customer': () => ({
        status: 400,
        body: {
          error: {
            code: 'invalid',
            message: 'The request is invalid',
            details: [{ path: ['Name'], message: 'Name already in use' }],
          },
        },
      }),
    });
    const { router, wrapper } = boot();
    await router.push('/objects/Customer/new');
    await vi.waitFor(() => expect(wrapper.find('[data-field="Name"] input').exists()).toBe(true));
    await wrapper.find('[data-field="Name"] input').setValue('Acme');
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-field="Name"] .gf-error').text()).toBe('Name already in use'),
    );
    expect(wrapper.find('[data-testid="form-error"]').text()).toBe('The request is invalid');
    wrapper.unmount();
  });
});

describe('generic edit form', () => {
  it('sends only changed fields, and after a conflict reapplies them on the current version', async () => {
    let n = 0;
    api({
      'PATCH /objects/Customer/C1': (r) => {
        posts.push(r);
        const id = `cmd-m${++n}`;
        commandRows[id] = { id, status: 'queued' };
        return { status: 202, body: { commandId: id } };
      },
    });
    const { router, wrapper } = boot();
    await router.push('/objects/Customer/C1/edit');
    await vi.waitFor(() => expect(wrapper.find('[data-field="Phone"] input').exists()).toBe(true));
    expect((wrapper.find('[data-field="Name"] input').element as HTMLInputElement).value).toBe(
      'Acme',
    );

    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-testid="form-error"]').text()).toBe('Nothing changed.');

    await wrapper.find('[data-field="Phone"] input').setValue('555-0199');
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ ListID: 'C1', EditSequence: '1', Phone: '555-0199' });
    expectXsdValid('CustomerModRq', posts[0]!.body);

    // Someone else changed the customer: QuickBooks answers 3200.
    commandRows['cmd-m1'] = {
      id: 'cmd-m1',
      status: 'conflict',
      status_code: 3200,
      status_message: 'The provided edit sequence "1" is out-of-date.',
      result: {
        current: { ...customerRet, EditSequence: '2', Phone: '555-0111', CompanyName: 'Acme Inc' },
      },
    };
    useEventsStore().dispatch({ type: 'command.updated', id: 'cmd-m1', status: 'conflict' });
    await vi.waitFor(() => expect(wrapper.find('.conflict-diff').exists()).toBe(true));
    const diff = wrapper
      .find('.conflict-diff [data-path="Phone"]')
      .findAll('td')
      .map((t) => t.text());
    expect(diff).toEqual(['Phone', '555-0100', '555-0111', '555-0199']);

    const reapplyBtn = wrapper
      .findAll('.conflict-diff button')
      .find((b) => b.text().includes('Reload and reapply'))!;
    await reapplyBtn.trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-field="Phone"] input').exists()).toBe(true));
    expect((wrapper.find('[data-field="Phone"] input').element as HTMLInputElement).value).toBe(
      '555-0199',
    );
    expect(
      (wrapper.find('[data-field="CompanyName"] input').element as HTMLInputElement).value,
    ).toBe('Acme Inc');
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body).toEqual({ ListID: 'C1', EditSequence: '2', Phone: '555-0199' });
    expectXsdValid('CustomerModRq', posts[1]!.body);
    wrapper.unmount();
  });
});

describe('generic list and detail', () => {
  it('lists objects, opens the detail page and offers edit for writers', async () => {
    api();
    const { router, wrapper } = boot();
    await router.push('/objects/Customer');
    await vi.waitFor(() => expect(wrapper.text()).toContain('Acme'));
    expect(wrapper.find('h1').text()).toBe('Customers');
    await wrapper.find('tbody tr').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/objects/Customer/C1'));
    await vi.waitFor(() => expect(wrapper.find('[data-field="Phone"] dd').exists()).toBe(true));
    expect(wrapper.find('[data-field="Phone"] dd').text()).toBe('555-0100');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Edit')).toBe(true);
    wrapper.unmount();
  });
});
