import type { RouteRecordRaw } from 'vue-router';
import type { NavItem } from '../types';
import { DESKTOP_ONLY } from './features';

export const routes: RouteRecordRaw[] = [
  {
    path: '/desktop-only/:feature',
    name: 'desktop-only',
    component: () => import('./DesktopOnlyView.vue'),
    meta: { title: 'Use QuickBooks Desktop' },
  },
];

export const nav: NavItem[] = DESKTOP_ONLY.map((f, i) => ({
  label: f.title,
  to: `/desktop-only/${f.slug}`,
  area: f.area,
  icon: f.icon,
  order: 900 + i,
}));
