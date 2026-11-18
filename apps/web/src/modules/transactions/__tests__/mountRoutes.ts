/** Mount a module's routes on their own (independent of the app shell and auth). */
import { flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { h } from 'vue';
import { createMemoryHistory, createRouter, RouterView, type RouteRecordRaw } from 'vue-router';

const Empty = () => null;
const Root = () => h(RouterView);

export async function mountRoutes(routes: RouteRecordRaw[], path: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [...routes, { path: '/:rest(.*)*', component: Empty }],
  });
  const wrapper = mount(Root, {
    global: { plugins: [router, PrimeVue, ToastService] },
    attachTo: document.body,
  });
  await router.push(path);
  await router.isReady();
  await flushPromises();
  return { wrapper, router };
}
