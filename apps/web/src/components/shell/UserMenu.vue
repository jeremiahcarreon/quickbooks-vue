<script setup lang="ts">
import Button from 'primevue/button';
import Menu from 'primevue/menu';
import type { MenuItem } from 'primevue/menuitem';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useCommandsStore } from '@/stores/commands';
import { useEventsStore } from '@/stores/events';

const auth = useAuthStore();
const router = useRouter();
const menu = ref<InstanceType<typeof Menu> | null>(null);

const items = computed<MenuItem[]>(() => [
  { label: auth.user?.email ?? '', disabled: true },
  { separator: true },
  {
    label: 'Sign out',
    icon: 'pi pi-sign-out',
    command: async () => {
      useEventsStore().disconnect();
      useCommandsStore().stop();
      await auth.logout();
      await router.push({ name: 'login' });
    },
  },
]);
</script>

<template>
  <Button
    :label="auth.user?.displayName || auth.user?.email"
    icon="pi pi-user"
    text
    size="small"
    aria-haspopup="true"
    aria-controls="user-menu"
    class="user-menu"
    @click="(e) => menu?.toggle(e)"
  />
  <Menu id="user-menu" ref="menu" :model="items" popup />
</template>
