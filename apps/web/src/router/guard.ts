import type { Router } from 'vue-router';
import { onUnauthorized } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

declare module 'vue-router' {
  interface RouteMeta {
    /** Permission required for the route (e.g. `admin`, `object:Invoice:read`). */
    permission?: string;
    /** Reachable without signing in. */
    public?: boolean;
    /** Window title. */
    title?: string;
  }
}

/**
 * Sign-in and permission checks. The session is loaded once (GET /auth/me);
 * unauthenticated users go to /login?redirect=..., users without a route's
 * permission see the "not allowed" page. Any 401 later sends the user back
 * to the login page.
 */
export function installAuthGuard(router: Router): void {
  router.beforeEach(async (to) => {
    const auth = useAuthStore();
    if (to.meta.public) {
      if (to.name === 'login' && auth.loaded && auth.isAuthenticated) {
        const r =
          typeof to.query.redirect === 'string' && to.query.redirect.startsWith('/')
            ? to.query.redirect
            : '/';
        return r;
      }
      return true;
    }
    try {
      await auth.fetchMe();
    } catch {
      return { name: 'login', query: { redirect: to.fullPath, offline: '1' } };
    }
    if (!auth.isAuthenticated) return { name: 'login', query: { redirect: to.fullPath } };
    const needed = to.matched.map((r) => r.meta.permission).filter((p): p is string => !!p);
    if (needed.some((p) => !auth.can(p))) {
      return { name: 'forbidden', query: { from: to.fullPath } };
    }
    return true;
  });

  router.afterEach((to) => {
    if (typeof document !== 'undefined') {
      document.title = to.meta.title ? `${to.meta.title} · QuickBooks Vue` : 'QuickBooks Vue';
    }
  });

  onUnauthorized(() => {
    const auth = useAuthStore();
    const wasIn = auth.isAuthenticated;
    auth.expire();
    const cur = router.currentRoute.value;
    if (wasIn && !cur.meta.public) {
      void router.push({ name: 'login', query: { redirect: cur.fullPath, expired: '1' } });
    }
  });
}
