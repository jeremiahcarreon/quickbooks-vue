/** Home dashboard at `/`. */
import type { RouteRecordRaw } from 'vue-router';
import type { NavItem } from '../types';

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('./views/HomeView.vue'),
    meta: { title: 'Home' },
  },
];

export const nav: NavItem[] = [
  { label: 'Home', to: '/', area: 'Home', icon: 'pi pi-home', order: 0 },
];
