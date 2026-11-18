<script setup lang="ts">
/** Sync state per entity type, live progress from sync.progress, and manual resync. */
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { useToast } from 'primevue/usetoast';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { adminApi } from '@/api/endpoints';
import type { SyncState } from '@/api/types';
import { formatDate, timeAgo } from '@/lib/format';
import { humanize } from '@/lib/labels';
import { useEventsStore } from '@/stores/events';

const toast = useToast();
const events = useEventsStore();
const states = ref<SyncState[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const filter = ref('');
const busy = ref<Record<string, boolean>>({});

async function load() {
  loading.value = true;
  error.value = null;
  try {
    states.value = await adminApi.sync();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

let off: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
onMounted(() => {
  void load();
  // refresh the table shortly after progress events settle
  off = events.on('sync.progress', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void load(), 1500);
  });
});
onBeforeUnmount(() => {
  off?.();
  if (timer) clearTimeout(timer);
});

const rows = computed(() => {
  const f = filter.value.trim().toLowerCase();
  return states.value
    .filter((s) => !f || s.type.toLowerCase().includes(f))
    .map((s) => ({ ...s, live: events.sync[s.type] }));
});

function severity(status: string | null | undefined) {
  if (!status) return 'secondary';
  if (/error|fail/i.test(status)) return 'danger';
  if (/run|progress|queued|sync/i.test(status)) return 'info';
  if (/ok|idle|done|complete|success/i.test(status)) return 'success';
  return 'secondary';
}

async function trigger(type: string, full: boolean) {
  busy.value = { ...busy.value, [type]: true };
  try {
    await adminApi.triggerSync(type, { full });
    toast.add({
      severity: 'info',
      summary: `${full ? 'Full resync' : 'Sync'} queued`,
      detail: humanize(type),
      life: 2500,
    });
    await load();
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not start sync',
      detail: (err as Error).message,
      life: 5000,
    });
  } finally {
    busy.value = { ...busy.value, [type]: false };
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>Sync status</h1>
      <span class="page-sub"
        >The read model mirrors QuickBooks; writes are applied immediately, the rest catches up
        here.</span
      >
      <div class="page-head__spacer" />
      <InputText v-model="filter" placeholder="Filter" size="small" aria-label="Filter types" />
      <Button
        icon="pi pi-refresh"
        text
        rounded
        aria-label="Refresh"
        :loading="loading"
        @click="load"
      />
    </div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <DataTable
      :value="rows"
      :loading="loading"
      data-key="type"
      size="small"
      striped-rows
      sort-field="type"
      :sort-order="1"
    >
      <Column field="type" header="Type" sortable>
        <template #body="{ data }">{{ humanize(data.type) }}</template>
      </Column>
      <Column field="status" header="Status" sortable>
        <template #body="{ data }">
          <Tag
            :value="data.live?.status ?? data.status ?? 'never'"
            :severity="severity(data.live?.status ?? data.status)"
          />
          <small v-if="data.live" class="sync__live"> {{ data.live.count }} rows</small>
        </template>
      </Column>
      <Column field="rowCount" header="Rows" sortable />
      <Column header="Last run" sortable field="lastRunAt">
        <template #body="{ data }">{{ timeAgo(data.lastRunAt) }}</template>
      </Column>
      <Column header="Last full sync">
        <template #body="{ data }">{{ formatDate(data.lastFullSyncAt) }}</template>
      </Column>
      <Column header="Error">
        <template #body="{ data }"
          ><span class="sync__error">{{ data.error ?? '' }}</span></template
        >
      </Column>
      <Column header="">
        <template #body="{ data }">
          <div class="sync__actions">
            <Button
              label="Sync now"
              size="small"
              text
              :loading="busy[data.type]"
              @click="trigger(data.type, false)"
            />
            <Button
              label="Full"
              size="small"
              text
              severity="secondary"
              :disabled="busy[data.type]"
              @click="trigger(data.type, true)"
            />
          </div>
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
.sync__live {
  color: var(--p-text-muted-color);
}
.sync__error {
  color: var(--p-red-500);
  font-size: 0.85rem;
}
.sync__actions {
  display: flex;
  gap: 0.25rem;
  white-space: nowrap;
}
</style>
