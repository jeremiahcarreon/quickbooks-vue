import type { RouteLocationNormalized, RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import type { NavItem } from '../types';

/** Only users who may read the entity type get its screens. */
function canReadType(to: RouteLocationNormalized) {
  const type = String(to.params.type ?? '');
  return useAuthStore().canRead(type) ? true : { name: 'forbidden', query: { from: to.fullPath } };
}
function canWriteType(to: RouteLocationNormalized) {
  const type = String(to.params.type ?? '');
  return useAuthStore().canWrite(type) ? true : { name: 'forbidden', query: { from: to.fullPath } };
}

export const routes: RouteRecordRaw[] = [
  {
    path: '/lists',
    name: 'entity-index',
    component: () => import('./EntityIndexView.vue'),
    meta: { title: 'Lists and transactions' },
  },
  {
    path: '/objects/:type',
    name: 'entity-list',
    component: () => import('./EntityListView.vue'),
    beforeEnter: canReadType,
  },
  {
    path: '/objects/:type/new',
    name: 'entity-new',
    component: () => import('./EntityFormView.vue'),
    beforeEnter: canWriteType,
  },
  {
    path: '/objects/:type/:id',
    name: 'entity-detail',
    component: () => import('./EntityDetailView.vue'),
    beforeEnter: canReadType,
  },
  {
    path: '/objects/:type/:id/edit',
    name: 'entity-edit',
    component: () => import('./EntityFormView.vue'),
    beforeEnter: canWriteType,
  },
  {
    path: '/ref/:id',
    name: 'ref-resolve',
    component: () => import('./RefResolveView.vue'),
  },
];

export const nav: NavItem[] = [
  {
    label: 'All lists & transactions',
    to: '/lists',
    area: 'Lists',
    icon: 'pi pi-th-large',
    order: 1,
  },
];
