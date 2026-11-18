import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import { createMemoryHistory } from 'vue-router';
import App from '@/App.vue';
import { installPlugins } from '@/plugins';
import { createAppRouter } from '@/router';
import { setEventSourceFactory, type EventSourceLike } from '@/stores/events';
import { ADMIN, CLERK, mockApi } from './helpers/api';

/** An event stream that opens and stays quiet. */
const silentES = (): EventSourceLike => {
  const es: EventSourceLike = {
    readyState: 0,
    onopen: null,
    onerror: null,
    onmessage: null,
    addEventListener() {},
    close() {},
  };
  setTimeout(() => es.onopen?.(new Event('open')), 0);
  return es;
};

function boot() {
  const router = createAppRouter(createMemoryHistory());
  const pinia = createPinia();
  const wrapper = mount(App, {
    global: { plugins: [{ install: (app: VueApp) => installPlugins(app, router, pinia) }] },
    attachTo: document.body,
  });
  return { router, wrapper };
}

beforeEach(() => {
  localStorage.clear();
  setEventSourceFactory(silentES);
});

describe('App', () => {
  it('sends signed-out users to the login page and back after signing in', async () => {
    let signedIn = false;
    const api = mockApi({
      'GET /auth/me': () =>
        signedIn
          ? ADMIN
          : {
              status: 401,
              body: { error: { code: 'unauthenticated', message: 'Login required' } },
            },
      'POST /auth/login': (r) => {
        const b = r.body as { password: string };
        if (b.password !== 'right')
          return { status: 401, body: { error: { code: 'bad_credentials', message: 'no' } } };
        signedIn = true;
        return ADMIN;
      },
      'GET /meta/entities': () => ({ entities: [] }),
      'GET /health': () => ({ status: 'ok', relay: 'ok' }),
    });
    const { router, wrapper } = boot();
    await router.push('/admin/users');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.redirect).toBe('/admin/users');

    await wrapper.find('#login-email').setValue('admin@example.test');
    await wrapper.find('#login-password').setValue('wrong');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-testid="login-error"]').text()).toBe('Wrong email or password.');

    await wrapper.find('#login-password').setValue('right');
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/admin/users'));
    await vi.waitFor(() => expect(api.calls.some((c) => c.path === '/admin/users')).toBe(true));
    wrapper.unmount();
  });

  it('builds the sidebar from module nav filtered by permission', async () => {
    mockApi({
      'GET /auth/me': () => ADMIN,
      'GET /meta/entities': () => ({ entities: [] }),
      'GET /health': () => ({ relay: { connected: true } }),
    });
    const { router, wrapper } = boot();
    await router.push('/');
    await flushPromises();
    const nav = wrapper.find('aside').text();
    expect(nav).toContain('All lists & transactions');
    expect(nav).toContain('Users');
    expect(nav).toContain('qbXML console');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="relay-status"]').classes()).toContain('relay-status--ok'),
    );
    wrapper.unmount();
  });

  it('hides admin navigation and blocks admin routes for non-admins', async () => {
    mockApi({
      'GET /auth/me': () => CLERK,
      'GET /meta/entities': () => ({ entities: [] }),
      'GET /health': () => ({}),
    });
    const { router, wrapper } = boot();
    await router.push('/');
    await flushPromises();
    const nav = wrapper.find('aside').text();
    expect(nav).not.toContain('Users');
    expect(nav).not.toContain('qbXML console');
    await router.push('/admin/qbxml');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('forbidden');
    expect(wrapper.text()).toContain('Not allowed');
    // entity screens check object permissions too
    await router.push('/objects/Invoice/new');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('forbidden');
    wrapper.unmount();
  });

  it('shows "not found" for unknown paths', async () => {
    mockApi({
      'GET /auth/me': () => ADMIN,
      'GET /meta/entities': () => [],
      'GET /health': () => ({}),
    });
    const { router, wrapper } = boot();
    await router.push('/does/not/exist');
    await flushPromises();
    expect(wrapper.text()).toContain('Page not found');
    wrapper.unmount();
  });
});
