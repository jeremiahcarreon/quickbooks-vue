import type { RouteRecordRaw } from 'vue-router';
import type { NavItem } from '../types';

export const routes: RouteRecordRaw[] = [
  { path: '/admin', redirect: '/admin/users' },
  {
    path: '/admin/users',
    name: 'admin-users',
    component: () => import('./UsersView.vue'),
    meta: { permission: 'admin', title: 'Users' },
  },
  {
    path: '/admin/roles',
    name: 'admin-roles',
    component: () => import('./RolesView.vue'),
    meta: { permission: 'admin', title: 'Roles' },
  },
  {
    path: '/admin/tokens',
    name: 'admin-tokens',
    component: () => import('./TokensView.vue'),
    meta: { permission: 'admin', title: 'API tokens' },
  },
  {
    path: '/admin/sync',
    name: 'admin-sync',
    component: () => import('./SyncView.vue'),
    meta: { permission: 'admin', title: 'Sync status' },
  },
  {
    path: '/admin/commands',
    name: 'admin-commands',
    component: () => import('./CommandsView.vue'),
    meta: { permission: 'command:read', title: 'Command history' },
  },
  {
    path: '/admin/qbxml',
    name: 'admin-qbxml',
    component: () => import('./QbxmlConsoleView.vue'),
    meta: { permission: 'qbxml:raw', title: 'qbXML console' },
  },
];

export const nav: NavItem[] = [
  {
    label: 'Users',
    to: '/admin/users',
    area: 'Admin',
    icon: 'pi pi-users',
    order: 10,
    permission: 'admin',
  },
  {
    label: 'Roles',
    to: '/admin/roles',
    area: 'Admin',
    icon: 'pi pi-shield',
    order: 20,
    permission: 'admin',
  },
  {
    label: 'API tokens',
    to: '/admin/tokens',
    area: 'Admin',
    icon: 'pi pi-key',
    order: 30,
    permission: 'admin',
  },
  {
    label: 'Sync status',
    to: '/admin/sync',
    area: 'Admin',
    icon: 'pi pi-sync',
    order: 40,
    permission: 'admin',
  },
  {
    label: 'Command history',
    to: '/admin/commands',
    area: 'Admin',
    icon: 'pi pi-history',
    order: 50,
    permission: 'command:read',
  },
  {
    label: 'qbXML console',
    to: '/admin/qbxml',
    area: 'Admin',
    icon: 'pi pi-code',
    order: 60,
    permission: 'qbxml:raw',
  },
];
