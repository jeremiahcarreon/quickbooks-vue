import type { RouteRecordRaw } from 'vue-router';
import type { NavItem } from '../types';

export const routes: RouteRecordRaw[] = [
  {
    path: '/company/actions/:name?',
    name: 'sdk-actions',
    component: () => import('./ActionsView.vue'),
    meta: { title: 'QuickBooks actions' },
  },
];

export const nav: NavItem[] = [
  {
    label: 'QuickBooks actions',
    to: '/company/actions',
    area: 'Company',
    icon: 'pi pi-bolt',
    order: 90,
  },
];
