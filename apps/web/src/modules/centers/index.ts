/** Customer Center and Vendor Center. */
import type { RouteRecordRaw } from 'vue-router';
import type { NavItem } from '../types';

const CenterView = () => import('./views/CenterView.vue');

export const routes: RouteRecordRaw[] = [
  {
    path: '/centers/customers/:id?',
    name: 'customer-center',
    component: CenterView,
    props: (r) => ({
      kind: 'customer',
      id: typeof r.params.id === 'string' && r.params.id ? r.params.id : undefined,
    }),
    meta: { title: 'Customer Center' },
  },
  {
    path: '/centers/vendors/:id?',
    name: 'vendor-center',
    component: CenterView,
    props: (r) => ({
      kind: 'vendor',
      id: typeof r.params.id === 'string' && r.params.id ? r.params.id : undefined,
    }),
    meta: { title: 'Vendor Center' },
  },
];

export const nav: NavItem[] = [
  {
    label: 'Customer Center',
    to: '/centers/customers',
    area: 'Customers',
    icon: 'pi pi-users',
    order: 10,
    permission: 'object:Customer:read',
  },
  {
    label: 'Vendor Center',
    to: '/centers/vendors',
    area: 'Vendors',
    icon: 'pi pi-truck',
    order: 10,
    permission: 'object:Vendor:read',
  },
];
