import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router';
import AppShell from '@/layouts/AppShell.vue';
import { allRoutes, modules, type RegisteredModule } from '@/modules/registry';

/**
 * Module routes render inside the app shell. A placeholder home page is used
 * until a module claims `/`; /login is outside the shell; a catch-all shows
 * "not found".
 */
export function buildRoutes(mods: RegisteredModule[] = modules): RouteRecordRaw[] {
  const children = allRoutes(mods);
  const hasHome = children.some((r) => r.path === '' || r.path === '/');
  if (!hasHome) {
    children.unshift({
      path: '',
      name: 'home-placeholder',
      component: () => import('@/views/WelcomeView.vue'),
    });
  }
  children.push({
    path: 'forbidden',
    name: 'forbidden',
    component: () => import('@/views/ForbiddenView.vue'),
    meta: { title: 'Not allowed' },
  });
  return [
    {
      path: '/',
      component: AppShell,
      children: children.map((r) => ({ ...r, path: r.path.replace(/^\//, '') }) as RouteRecordRaw),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true, title: 'Sign in' },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { public: true },
    },
  ];
}

export function createAppRouter(
  history: RouterHistory = createWebHistory(),
  mods?: RegisteredModule[],
): Router {
  return createRouter({ history, routes: buildRoutes(mods) });
}
