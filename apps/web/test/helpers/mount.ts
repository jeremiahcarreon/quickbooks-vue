import Aura from '@primeuix/themes/aura';
import { mount, type ComponentMountingOptions } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';
import { defineComponent, type Component } from 'vue';
import { createMemoryHistory, createRouter, type RouteRecordRaw, type Router } from 'vue-router';

const Stub = defineComponent({ template: '<div />' });

export function makeRouter(
  routes: RouteRecordRaw[] = [{ path: '/:p(.*)*', component: Stub }],
): Router {
  return createRouter({ history: createMemoryHistory(), routes });
}

/** Mount with Pinia, PrimeVue (Aura), Toast/Confirm services and a memory router. */
export function mountWith<C extends Component>(
  component: C,
  options: ComponentMountingOptions<C> & { pinia?: Pinia; router?: Router } = {},
) {
  const pinia = options.pinia ?? createPinia();
  setActivePinia(pinia);
  const router = options.router ?? makeRouter();
  const { pinia: _p, router: _r, ...rest } = options;
  return mount(component, {
    attachTo: document.body,
    ...rest,
    global: {
      ...(rest.global ?? {}),
      plugins: [
        pinia,
        router,
        [PrimeVue, { theme: { preset: Aura, options: { darkModeSelector: '.app-dark' } } }],
        ToastService,
        ConfirmationService,
        ...((rest.global?.plugins as unknown[]) ?? []),
      ] as never,
    },
  } as ComponentMountingOptions<C>);
}
