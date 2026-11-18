import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError, setCsrfToken } from '@/api/client';
import { authApi } from '@/api/endpoints';
import type { CurrentUser } from '@/api/types';
import { hasPermission } from '@/lib/permissions';

/**
 * Session state. The session itself is an HttpOnly cookie; this store keeps
 * the current user, their permissions and the CSRF token for writes.
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<CurrentUser | null>(null);
  /** True once /auth/me has answered (logged in or not). */
  const loaded = ref(false);
  const loading = ref(false);
  let pending: Promise<CurrentUser | null> | null = null;

  const isAuthenticated = computed(() => user.value !== null);
  const permissions = computed(() => user.value?.permissions ?? []);
  const isAdmin = computed(() => permissions.value.includes('admin'));

  function can(permission: string | undefined | null): boolean {
    if (!permission) return true;
    return hasPermission(permissions.value, permission);
  }
  const canRead = (type: string) => can(`object:${type}:read`);
  const canWrite = (type: string) => can(`object:${type}:write`);

  function applySession(u: CurrentUser | null, csrf: string | null) {
    user.value = u;
    setCsrfToken(csrf);
    loaded.value = true;
  }

  /** Load the session once; concurrent callers share the request. */
  async function fetchMe(force = false): Promise<CurrentUser | null> {
    if (loaded.value && !force) return user.value;
    if (pending) return pending;
    loading.value = true;
    pending = (async () => {
      try {
        const s = await authApi.me();
        applySession(s.user, s.csrfToken);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          applySession(null, null);
        } else {
          loaded.value = true;
          throw err;
        }
      } finally {
        loading.value = false;
        pending = null;
      }
      return user.value;
    })();
    return pending;
  }

  async function login(email: string, password: string): Promise<CurrentUser> {
    loading.value = true;
    try {
      const s = await authApi.login(email, password);
      let u = s.user;
      setCsrfToken(s.csrfToken);
      // Some responses only set the cookie; ask who we are.
      if (!u || !u.permissions.length) {
        const me = await authApi.me();
        u = me.user;
        if (me.csrfToken) s.csrfToken = me.csrfToken;
      }
      if (!u) throw new ApiError(401, 'unauthenticated', 'Login failed');
      applySession(u, s.csrfToken);
      return u;
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout();
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
    } finally {
      applySession(null, null);
    }
  }

  /** Called when any request answers 401: the session is gone. */
  function expire() {
    user.value = null;
    setCsrfToken(null);
    loaded.value = true;
  }

  return {
    user,
    loaded,
    loading,
    isAuthenticated,
    permissions,
    isAdmin,
    can,
    canRead,
    canWrite,
    fetchMe,
    login,
    logout,
    expire,
  };
});
