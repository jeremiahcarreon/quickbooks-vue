<script setup lang="ts">
import Button from 'primevue/button';
import Card from 'primevue/card';
import { useToast } from 'primevue/usetoast';
import { ref } from 'vue';
import { api, ApiError } from '@/api/client';

const toast = useToast();
const checking = ref(false);

async function checkApi() {
  checking.value = true;
  try {
    const health = await api.get<Record<string, unknown>>('/health');
    toast.add({
      severity: 'success',
      summary: 'API reachable',
      detail: JSON.stringify(health),
      life: 4000,
    });
  } catch (err) {
    const msg = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
    toast.add({ severity: 'warn', summary: 'API not reachable', detail: msg, life: 4000 });
  } finally {
    checking.value = false;
  }
}
</script>

<template>
  <Card>
    <template #title>QuickBooks Vue</template>
    <template #content>
      <p>
        The application shell is running. Feature modules register themselves under
        <code>src/modules</code>.
      </p>
      <Button label="Check API" icon="pi pi-heart" :loading="checking" @click="checkApi" />
    </template>
  </Card>
</template>
