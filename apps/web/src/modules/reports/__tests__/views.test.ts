import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { setFetch } from '@/api/client';
import ReportTable from '../components/ReportTable.vue';
import reportsModule, { nav, routes } from '../index';
import type { ReportCatalog, ReportResult } from '../types';

const catalog: ReportCatalog = {
  categories: ['Customers & Receivables', 'Company & Financial'],
  reports: [
    {
      name: 'ar-aging-summary',
      title: 'A/R Aging Summary',
      description: 'Open receivables by age',
      category: 'Customers & Receivables',
      source: 'sql',
      params: [
        { name: 'asOf', label: 'As of', type: 'date', group: 'period' },
        {
          name: 'interval',
          label: 'Days per aging period',
          type: 'integer',
          default: 30,
          group: 'layout',
        },
      ],
    },
    {
      name: 'GeneralSummary.ProfitAndLossStandard',
      title: 'Profit & Loss Standard',
      description: 'From QuickBooks',
      category: 'Company & Financial',
      source: 'qb',
      params: [
        { name: 'from', label: 'From', type: 'date', group: 'period' },
        { name: 'to', label: 'To', type: 'date', group: 'period' },
        {
          name: 'ReportBasis',
          label: 'Basis',
          type: 'enum',
          options: ['Accrual', 'Cash'],
          group: 'layout',
        },
      ],
    },
  ],
};

const result = (title: string, source: 'sql' | 'qb'): ReportResult => ({
  columns: [
    { key: 'c1', title: '', type: 'text' },
    { key: 'c2', title: 'TOTAL', type: 'amount' },
  ],
  rows: [
    { kind: 'text', indent: 0, label: 'Income', cells: { c1: 'Income' } },
    { kind: 'data', indent: 1, label: 'Sales', cells: { c1: 'Sales', c2: 1500 } },
    { kind: 'data', indent: 1, label: 'Refunds', cells: { c1: 'Refunds', c2: -20 } },
    { kind: 'subtotal', indent: 0, label: 'Total Income', cells: { c1: 'Total Income', c2: 1480 } },
    { kind: 'total', indent: 0, label: 'Net Income', cells: { c1: 'Net Income', c2: 1480 } },
  ],
  totals: { c1: 'Net Income', c2: 1480 },
  meta: {
    name: 'x',
    title,
    subtitle: 'January 2024',
    source,
    params: {},
    generatedAt: '2024-02-01T00:00:00Z',
    fetchedAt: '2024-02-01T00:00:00Z',
    cached: source === 'qb',
    basis: source === 'qb' ? 'Accrual' : undefined,
    rowCount: 2,
    notes: ['A note'],
  },
});

// jsdom has no matchMedia; PrimeVue's Select asks it for the responsive overlay.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

let calls: string[] = [];
let pendingOnce = false;

function installFetch() {
  calls = [];
  setFetch(async (input) => {
    const url = String(input);
    calls.push(url);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url === '/api/reports') return json(200, catalog);
    if (url.startsWith('/api/reports/ar-aging-summary'))
      return json(200, { status: 'ready', ...result('A/R Aging Summary', 'sql') });
    if (url.startsWith('/api/reports/GeneralSummary.ProfitAndLossStandard')) {
      if (pendingOnce && !url.includes('commandId')) {
        return json(202, { status: 'pending', commandId: 'cmd-9', commandStatus: 'queued' });
      }
      return json(200, { status: 'ready', ...result('Profit & Loss', 'qb') });
    }
    return json(404, { error: { code: 'not_found', message: 'nope' } });
  });
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [...routes, { path: '/', component: { template: '<div />' } }],
  });
}

async function mountAt(path: string) {
  const router = makeRouter();
  await router.push(path);
  await router.isReady();
  const Root = { template: '<RouterView />' };
  const wrapper = mount(Root, { global: { plugins: [router, PrimeVue] }, attachTo: document.body });
  await flushPromises();
  await new Promise((r) => setTimeout(r, 0));
  await flushPromises();
  return { wrapper, router };
}

beforeEach(() => {
  setActivePinia(createPinia());
  pendingOnce = false;
  installFetch();
});
afterEach(() => {
  setFetch((...a) => globalThis.fetch(...a));
  document.body.innerHTML = '';
});

describe('module registration', () => {
  it('exports routes and nav for the registry', () => {
    expect(routes.map((r) => r.name)).toEqual(['reports', 'report-run']);
    expect(nav.every((n) => n.area === 'Reports')).toBe(true);
    expect(nav.find((n) => n.to === '/reports/ar-aging-summary')?.permission).toBe(
      'report:ar-aging-summary',
    );
    expect(reportsModule.routes).toBe(routes);
  });
});

describe('ReportTable', () => {
  it('renders kinds, indentation, number formatting and links', async () => {
    const w = mount(ReportTable, {
      props: {
        result: {
          ...result('P&L', 'sql'),
          rows: [
            ...result('P&L', 'sql').rows.slice(0, 1),
            {
              kind: 'data',
              indent: 2,
              cells: { c1: 'Linked', c2: 5 },
              ref: { type: 'Customer', id: 'C1' },
            },
          ],
        },
      },
    });
    const rows = w.findAll('tbody tr');
    expect(rows[0]!.classes()).toContain('row--text');
    expect(rows[0]!.find('th').attributes('colspan')).toBe('2');
    expect(rows[1]!.find('td').attributes('style')).toContain('padding-left: 3rem');
    await rows[1]!.find('a.report-link').trigger('click');
    expect(w.emitted('open')).toEqual([[{ type: 'Customer', id: 'C1' }]]);
  });

  it('styles subtotals, totals and negatives', () => {
    const w = mount(ReportTable, { props: { result: result('P&L', 'sql') } });
    const rows = w.findAll('tbody tr');
    expect(rows.map((r) => r.classes()[0])).toEqual([
      'row--text',
      'row--data',
      'row--data',
      'row--subtotal',
      'row--total',
    ]);
    expect(rows[1]!.findAll('td')[1]!.text()).toBe('1,500.00');
    expect(rows[2]!.findAll('td')[1]!.classes()).toContain('is-neg');
    expect(rows[4]!.text()).toContain('Net Income');
    expect(w.find('thead th.is-num').text()).toBe('TOTAL');
  });

  it('shows an empty state', () => {
    const r = result('Empty', 'sql');
    const w = mount(ReportTable, { props: { result: { ...r, rows: [] } } });
    expect(w.text()).toContain('No data for these settings.');
  });
});

describe('ReportCatalogView', () => {
  it('lists reports by category and filters by search and source', async () => {
    const { wrapper } = await mountAt('/reports');
    expect(wrapper.text()).toContain('Customers & Receivables');
    expect(wrapper.text()).toContain('A/R Aging Summary');
    expect(wrapper.text()).toContain('Profit & Loss Standard');
    await wrapper.find('input[aria-label="Find a report"]').setValue('profit');
    await flushPromises();
    expect(wrapper.text()).not.toContain('A/R Aging Summary');
    expect(wrapper.text()).toContain('Profit & Loss Standard');
    expect(wrapper.find('a.report-item').attributes('href')).toBe(
      '/reports/GeneralSummary.ProfitAndLossStandard',
    );
    wrapper.unmount();
  });
});

describe('ReportRunView', () => {
  it('runs an instant report on load and mirrors params into the URL', async () => {
    const { wrapper, router } = await mountAt('/reports/ar-aging-summary?asOf=2024-03-31');
    expect(
      calls.some((c) => c.startsWith('/api/reports/ar-aging-summary?asOf=2024-03-31&interval=30')),
    ).toBe(true);
    expect(wrapper.find('.report-print-area').exists()).toBe(true);
    expect(wrapper.find('.report-print-area h2').text()).toBe('A/R Aging Summary');
    expect(wrapper.findAll('tr.row--subtotal')).toHaveLength(1);
    expect(router.currentRoute.value.query).toEqual({ asOf: '2024-03-31', interval: '30' });
    expect(wrapper.text()).toContain('A note');
    wrapper.unmount();
  });

  it('waits for the user on QuickBooks reports, then polls a pending result', async () => {
    pendingOnce = true;
    const { wrapper } = await mountAt(
      '/reports/GeneralSummary.ProfitAndLossStandard?from=2024-01-01&to=2024-01-31',
    );
    expect(calls.filter((c) => c.startsWith('/api/reports/General'))).toHaveLength(0);
    expect(wrapper.text()).toContain('Refresh from QuickBooks');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    await new Promise((r) => setTimeout(r, 1700));
    await flushPromises();
    const runs = calls.filter((c) => c.startsWith('/api/reports/General'));
    expect(runs[0]).toBe(
      '/api/reports/GeneralSummary.ProfitAndLossStandard?from=2024-01-01&to=2024-01-31',
    );
    expect(runs[1]).toContain('commandId=cmd-9');
    expect(wrapper.find('.report-print-area h2').text()).toBe('Profit & Loss');
    expect(wrapper.text()).toContain('Accrual basis');
    expect(wrapper.text()).toContain('(cached)');
    wrapper.unmount();
  });

  it('refresh asks the API to bypass the cache', async () => {
    const { wrapper } = await mountAt('/reports/GeneralSummary.ProfitAndLossStandard');
    const refresh = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Refresh from QuickBooks'))!;
    await refresh.trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.includes('refresh=true'))).toBe(true);
    wrapper.unmount();
  });

  it('explains unknown reports', async () => {
    const { wrapper } = await mountAt('/reports/nope');
    expect(wrapper.text()).toContain('does not exist or you do not have access');
    wrapper.unmount();
  });
});
