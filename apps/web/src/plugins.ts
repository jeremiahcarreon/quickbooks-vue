import Aura from '@primeuix/themes/aura';
import { createPinia, type Pinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import type { App } from 'vue';
import type { Router } from 'vue-router';
import { installAuthGuard } from './router/guard';

/** Install Pinia, the router (with the auth guard) and PrimeVue (Aura theme). Shared by main.ts and tests. */
export function installPlugins(app: App, router: Router, pinia: Pinia = createPinia()): void {
  app.use(pinia);
  installAuthGuard(router);
  app.use(router);
  app.use(PrimeVue, {
    theme: {
      preset: Aura,
      options: { darkModeSelector: '.app-dark', cssLayer: false },
    },
  });
  app.use(ToastService);
  app.use(ConfirmationService);
  app.directive('tooltip', Tooltip);
}
