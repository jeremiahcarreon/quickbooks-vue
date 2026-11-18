<script setup lang="ts">
/**
 * Signed-in layout: top bar (global search, relay status, command tray, user
 * menu) and the sidebar built from module nav, grouped by area and filtered
 * by the user's permissions. Starts the live event stream and the command
 * tray for the session.
 */
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import CommandTray from '@/components/shell/CommandTray.vue';
import GlobalSearch from '@/components/shell/GlobalSearch.vue';
import RelayStatus from '@/components/shell/RelayStatus.vue';
import UserMenu from '@/components/shell/UserMenu.vue';
import { trayBus } from '@/components/trayBus';
import { modules, navGroups } from '@/modules/registry';
import { useAuthStore } from '@/stores/auth';
import { useCommandsStore } from '@/stores/commands';
import { useEventsStore } from '@/stores/events';
import { useMetaStore } from '@/stores/meta';

const auth = useAuthStore();
const events = useEventsStore();
const commands = useCommandsStore();
const meta = useMetaStore();
const toast = useToast();
const route = useRoute();

const groups = computed(() => navGroups(modules, (p) => auth.can(p)));
const sideOpen = ref(false);
watch(
  () => route.fullPath,
  () => (sideOpen.value = false),
);

let offSettled: (() => void) | null = null;
onMounted(() => {
  events.connect();
  commands.start();
  void meta.loadEntities().catch(() => undefined);
  offSettled = commands.onSettled((c) => {
    if (c.status === 'succeeded') {
      toast.add({
        severity: 'success',
        summary: 'Saved in QuickBooks',
        detail: c.label,
        life: 3000,
      });
    } else if (c.status === 'conflict') {
      toast.add({
        severity: 'warn',
        summary: 'Edit conflict',
        detail: `${c.label}: changed in QuickBooks meanwhile. Open the tray to resolve.`,
        life: 8000,
      });
    } else {
      toast.add({
        severity: 'error',
        summary: c.status === 'rejected' ? 'Rejected' : 'QuickBooks error',
        detail: `${c.label}: ${c.statusMessage ?? c.status}`,
        life: 8000,
      });
    }
  });
});
onBeforeUnmount(() => {
  offSettled?.();
  events.disconnect();
  commands.stop();
});
</script>

<template>
  <div class="shell" :class="{ 'shell--side-open': sideOpen }">
    <header class="shell__top">
      <Button
        class="shell__menu"
        icon="pi pi-bars"
        text
        rounded
        aria-label="Toggle navigation"
        @click="sideOpen = !sideOpen"
      />
      <RouterLink to="/" class="shell__brand">
        <i class="pi pi-book" aria-hidden="true" />
        <span>QuickBooks Vue</span>
      </RouterLink>
      <div class="shell__search"><GlobalSearch /></div>
      <div class="shell__spacer" />
      <RelayStatus />
      <CommandTray />
      <UserMenu />
      <slot name="top-right" />
    </header>
    <aside class="shell__side" aria-label="Main navigation">
      <nav>
        <section v-for="g in groups" :key="g.area" class="shell__group">
          <h2 class="shell__area">{{ g.area }}</h2>
          <RouterLink v-for="item in g.items" :key="item.to" :to="item.to" class="shell__link">
            <i v-if="item.icon" :class="item.icon" aria-hidden="true" />
            <span>{{ item.label }}</span>
          </RouterLink>
        </section>
        <p v-if="groups.length === 0" class="shell__empty">No modules installed yet.</p>
      </nav>
    </aside>
    <main class="shell__main">
      <RouterView />
    </main>
    <button
      v-if="commands.conflicts.length"
      type="button"
      class="shell__conflicts"
      @click="trayBus.open()"
    >
      <i class="pi pi-exclamation-triangle" aria-hidden="true" />
      {{ commands.conflicts.length }} edit conflict{{ commands.conflicts.length === 1 ? '' : 's' }}
    </button>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 15rem 1fr;
  grid-template-rows: 3.25rem 1fr;
  grid-template-areas: 'top top' 'side main';
  height: 100vh;
}
.shell__top {
  grid-area: top;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0 1rem;
  border-bottom: 1px solid var(--p-content-border-color);
  background: var(--p-content-background);
}
.shell__menu {
  display: none;
}
.shell__brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
  color: var(--p-primary-color);
  text-decoration: none;
  white-space: nowrap;
}
.shell__search {
  flex: 0 1 28rem;
  margin-left: 1rem;
}
.shell__spacer {
  flex: 1;
}
.shell__side {
  grid-area: side;
  overflow-y: auto;
  padding: 0.75rem 0.5rem;
  border-right: 1px solid var(--p-content-border-color);
  background: var(--p-content-background);
}
.shell__group + .shell__group {
  margin-top: 0.75rem;
}
.shell__area {
  margin: 0 0 0.25rem;
  padding: 0 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color);
}
.shell__link {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  border-radius: var(--p-content-border-radius);
  color: var(--p-text-color);
  text-decoration: none;
}
.shell__link:hover {
  background: var(--p-content-hover-background);
}
.shell__link.router-link-active {
  background: var(--p-highlight-background);
  color: var(--p-highlight-color);
}
.shell__empty {
  padding: 0 0.5rem;
  color: var(--p-text-muted-color);
}
.shell__main {
  grid-area: main;
  padding: 1.25rem;
  overflow: auto;
}
.shell__conflicts {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  border: 0;
  border-radius: 999px;
  padding: 0.5rem 0.9rem;
  background: var(--p-orange-500);
  color: #fff;
  cursor: pointer;
  box-shadow: 0 2px 8px rgb(0 0 0 / 20%);
}
@media (max-width: 900px) {
  .shell__search {
    display: none;
  }
}
@media (max-width: 768px) {
  .shell {
    grid-template-columns: 1fr;
    grid-template-areas: 'top' 'main';
  }
  .shell__menu {
    display: inline-flex;
  }
  .shell__brand span {
    display: none;
  }
  .shell__side {
    display: none;
  }
  .shell--side-open .shell__side {
    display: block;
    position: fixed;
    top: 3.25rem;
    bottom: 0;
    left: 0;
    width: 16rem;
    z-index: 10;
    box-shadow: 2px 0 8px rgb(0 0 0 / 15%);
  }
}
</style>
