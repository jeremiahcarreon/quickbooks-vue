import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SpotlightSearch from '@/components/shell/SpotlightSearch.vue';
import {
  activeFilterCount,
  canSearch,
  datePresets,
  emptyFilters,
  hitText,
  isSpotlightShortcut,
  matchMenu,
} from '@/lib/spotlight';
import type { NavItem } from '@/modules/types';
import { useAuthStore } from '@/stores/auth';
import { useMetaStore } from '@/stores/meta';
import { ADMIN, mockApi } from './helpers/api';
import { entities, objects } from './helpers/catalog';
import { makeRouter, mountWith } from './helpers/mount';

const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('spotlight helpers', () => {
  it('recognises Ctrl+K and Cmd+K only', () => {
    expect(isSpotlightShortcut(key('k', { ctrlKey: true }))).toBe(true);
    expect(isSpotlightShortcut(key('K', { metaKey: true }))).toBe(true);
    expect(isSpotlightShortcut(key('k'))).toBe(false);
    expect(isSpotlightShortcut(key('k', { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('ranks menu matches: label prefix, word prefix, then substring/area', () => {
    const items: NavItem[] = [
      { label: 'Pay Bills', to: '/pay-bills', area: 'Vendors' },
      { label: 'Bills', to: '/bills', area: 'Vendors' },
      { label: 'Unpaid bills report', to: '/r/unpaid', area: 'Reports' },
      { label: 'Customers', to: '/customers', area: 'Customers' },
    ];
    expect(matchMenu(items, 'bil').map((i) => i.to)).toEqual(['/bills', '/pay-bills', '/r/unpaid']);
    expect(matchMenu(items, 'vendors').map((i) => i.to)).toEqual(['/bills', '/pay-bills']);
    expect(matchMenu(items, '  ')).toEqual([]);
  });

  it('describes transaction and list hits', () => {
    const base = {
      type: 'Invoice',
      qbId: 'T1',
      name: 'Acme',
      refNumber: '1001',
      txnDate: '2026-03-01',
      amount: '1250.5',
      isActive: null,
      entityRefId: 'C1',
      entityName: 'Acme',
      companyName: null,
      email: null,
      phone: null,
      memo: null,
    };
    const t = hitText(base, 'txn');
    expect(t.title).toBe('Invoice #1001');
    expect(t.subtitle).toContain('Acme');
    expect(t.amount).toContain('1,250.50');
    const l = hitText(
      { ...base, type: 'Customer', email: 'ap@acme.test', isActive: false },
      'list',
    );
    expect(l).toEqual({ title: 'Acme', subtitle: 'ap@acme.test · Inactive', amount: '' });
  });

  it('computes date presets, filter counts and when a search can run', () => {
    const p = Object.fromEntries(datePresets(new Date(2026, 1, 15)).map((x) => [x.label, x.range]));
    expect(p['This month']).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(p['Last month']).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(p['This quarter']).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(p['Last year']).toEqual({ from: '2025-01-01', to: '2025-12-31' });

    const f = emptyFilters();
    expect(activeFilterCount(f)).toBe(0);
    expect(canSearch('a', f)).toBe(false);
    expect(canSearch('ac', f)).toBe(true);
    f.entityId = 'C1';
    f.includeInactive = true;
    expect(activeFilterCount(f)).toBe(2);
    expect(canSearch('', f)).toBe(true);
  });
});

describe('SpotlightSearch', () => {
  let pinia = createPinia();
  let mounted: { unmount(): void } | undefined;
  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    pinia = createPinia();
    setActivePinia(pinia);
  });
  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    vi.useRealTimers();
    document.body.innerHTML = '';
    document.body.style.overflow = '';
  });

  async function setup() {
    const api = mockApi({
      'GET /auth/me': () => ADMIN,
      'GET /search': (req) => ({
        groups: [
          {
            type: 'Invoice',
            category: 'txn',
            total: req.query.get('types') ? 1 : 12,
            items: [
              {
                type: 'Invoice',
                qbId: 'T1',
                name: 'Acme',
                refNumber: '1001',
                txnDate: '2026-03-01',
                amount: '100.00',
                isActive: null,
                entityRefId: 'C1',
                entityName: 'Acme',
                companyName: null,
                email: null,
                phone: null,
                memo: null,
              },
            ],
          },
          { type: 'Customer', category: 'list', total: 3, items: [] },
        ],
      }),
    });
    await useAuthStore().fetchMe();
    useMetaStore().seed({ entities: Object.values(entities), objects });
    const router = makeRouter();
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined);
    const w = mountWith(SpotlightSearch, { pinia, router });
    mounted = w;
    return { w, api, push };
  }

  const panel = () => document.querySelector('.spot__panel');
  const input = () => document.querySelector<HTMLInputElement>('.spot__input')!;

  it('opens with Ctrl+K as a large overlay and searches as you type', async () => {
    const { api } = await setup();
    expect(panel()).toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    await flushPromises();
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(input());

    input().value = 'acme';
    input().dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();

    const search = api.calls.find((c) => c.path === '/search');
    expect(search?.query.get('q')).toBe('acme');
    expect(document.querySelector('.spot__results')?.textContent).toContain('Invoice #1001');
    const chips = [...document.querySelectorAll('.spot__chip')].map((c) => c.textContent?.trim());
    expect(chips).toEqual(['All 15', 'Customers 3', 'Invoices 12']);
  });

  it('narrows to a type when its chip is clicked, and opens a hit with Enter', async () => {
    const { api, push } = await setup();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    await flushPromises();
    input().value = 'acme';
    input().dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();

    const chip = [...document.querySelectorAll<HTMLButtonElement>('.spot__chip')].find((c) =>
      c.textContent?.includes('Invoices'),
    )!;
    chip.click();
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    const last = api.calls.filter((c) => c.path === '/search').at(-1);
    expect(last?.query.get('types')).toBe('Invoice');
    expect(last?.query.get('perType')).toBe('50');

    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushPromises();
    expect(push).toHaveBeenCalledWith({
      name: 'entity-detail',
      params: { type: 'Invoice', id: 'T1' },
    });
    expect(panel()).toBeNull();
  });

  it('closes on Escape', async () => {
    await setup();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    await flushPromises();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(panel()).toBeNull();
  });
});
