import { describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';
import { collectModules, navGroups } from '@/modules/registry';
import { buildRoutes } from '@/router';

const Dummy = defineComponent({ template: '<div />' });

describe('module registry', () => {
  const mods = collectModules({
    './vendors/index.ts': {
      routes: [{ path: '/vendors', component: Dummy }],
      nav: [{ label: 'Vendors', to: '/vendors', area: 'Vendors', icon: 'pi pi-truck' }],
    },
    './customers/index.ts': {
      default: {
        routes: [{ path: '/customers', component: Dummy }],
        nav: [
          { label: 'Invoices', to: '/invoices', area: 'Customers', order: 20 },
          { label: 'Customers', to: '/customers', area: 'Customers', order: 10 },
          { label: 'Users', to: '/admin/users', area: 'Admin', permission: 'admin' },
        ],
      },
    },
    './empty/index.ts': {},
  });

  it('accepts named or default exports and sorts by name', () => {
    expect(mods.map((m) => m.name)).toEqual(['customers', 'empty', 'vendors']);
    expect(mods[1]).toEqual({ name: 'empty', routes: [], nav: [] });
  });

  it('groups nav by area in sidebar order, sorted and permission-filtered', () => {
    const groups = navGroups(mods, (p) => p !== 'admin');
    expect(groups.map((g) => g.area)).toEqual(['Customers', 'Vendors']);
    expect(groups[0]!.items.map((i) => i.label)).toEqual(['Customers', 'Invoices']);
    expect(navGroups(mods).map((g) => g.area)).toEqual(['Customers', 'Vendors', 'Admin']);
  });

  it('nests module routes in the shell and keeps a placeholder home until a module claims /', () => {
    const routes = buildRoutes(mods);
    const shell = routes[0]!;
    expect(shell.path).toBe('/');
    expect(shell.children!.map((r) => r.path)).toEqual(['', 'customers', 'vendors', 'forbidden']);
    expect(shell.children![0]!.name).toBe('home-placeholder');

    const withHome = buildRoutes(
      collectModules({
        './home/index.ts': { routes: [{ path: '/', name: 'home', component: Dummy }] },
      }),
    );
    expect(withHome[0]!.children!.map((r) => r.name)).toEqual(['home', 'forbidden']);
    expect(routes[1]!.name).toBe('login');
    expect(routes.at(-1)!.name).toBe('not-found');
  });
});
