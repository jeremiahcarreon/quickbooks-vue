<script setup lang="ts">
/** Command history (every queued write / query) with the request and response qbXML. */
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Drawer from 'primevue/drawer';
import Message from 'primevue/message';
import Select from 'primevue/select';
import Tag from 'primevue/tag';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { commandsApi } from '@/api/endpoints';
import type { Command } from '@/api/types';
import PendingBadge from '@/components/PendingBadge.vue';
import XmlView from '@/components/XmlView.vue';
import { formatDate } from '@/lib/format';
import { humanize } from '@/lib/labels';
import { useEventsStore } from '@/stores/events';

const events = useEventsStore();
const items = ref<Command[]>([]);
const next = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const status = ref<string>('');
const selected = ref<Command | null>(null);

const STATUSES = ['', 'queued', 'sending', 'succeeded', 'failed', 'conflict', 'rejected'].map(
  (s) => ({
    label: s || 'Any status',
    value: s,
  }),
);

async function load(more = false) {
  loading.value = true;
  error.value = null;
  try {
    const res = await commandsApi.list({
      ...(status.value ? { status: status.value } : {}),
      ...(more && next.value ? { cursor: next.value } : {}),
      pageSize: 50,
    });
    items.value = more ? [...items.value, ...res.items] : res.items;
    next.value = res.next;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}
watch(status, () => void load());

async function open(c: Command) {
  selected.value = c;
  try {
    selected.value = await commandsApi.get(c.id);
  } catch {
    // keep the list row
  }
}

let off: (() => void) | null = null;
onMounted(() => {
  void load();
  off = events.on('command.updated', (e) => {
    if (e.type !== 'command.updated') return;
    const i = items.value.findIndex((c) => c.id === e.id);
    if (i >= 0) items.value[i] = { ...items.value[i]!, status: e.status };
  });
});
onBeforeUnmount(() => off?.());
</script>

<template>
  <div>
    <div class="page-head">
      <h1>Command history</h1>
      <div class="page-head__spacer" />
      <Select
        v-model="status"
        :options="STATUSES"
        option-label="label"
        option-value="value"
        size="small"
      />
      <Button
        icon="pi pi-refresh"
        text
        rounded
        aria-label="Refresh"
        :loading="loading"
        @click="load()"
      />
    </div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <DataTable
      :value="items"
      :loading="loading"
      data-key="id"
      size="small"
      striped-rows
      row-hover
      @row-click="(e) => open(e.data)"
    >
      <Column header="When"
        ><template #body="{ data }">{{ formatDate(data.createdAt) }}</template></Column
      >
      <Column field="kind" header="Kind" />
      <Column header="Request"
        ><template #body="{ data }">{{ data.rqName ?? '' }}</template></Column
      >
      <Column header="Object">
        <template #body="{ data }"
          >{{ data.objectType ? humanize(data.objectType) : '' }}
          <code v-if="data.objectId">{{ data.objectId }}</code></template
        >
      </Column>
      <Column header="Status"
        ><template #body="{ data }"><PendingBadge :status="data.status" /></template
      ></Column>
      <Column header="QB status">
        <template #body="{ data }">
          <span v-if="data.statusCode !== null"
            >{{ data.statusCode }} {{ data.statusMessage }}</span
          >
        </template>
      </Column>
      <Column header="By"
        ><template #body="{ data }">{{ data.actorType }}</template></Column
      >
    </DataTable>
    <div v-if="next" class="commands__more">
      <Button label="Load more" text :loading="loading" @click="load(true)" />
    </div>

    <Drawer
      :visible="!!selected"
      position="right"
      :header="selected?.rqName ?? 'Command'"
      :style="{ width: 'min(48rem, 100vw)' }"
      @update:visible="(v) => !v && (selected = null)"
    >
      <template v-if="selected">
        <p>
          <Tag :value="selected.status" /> <code>{{ selected.id }}</code>
          <span v-if="selected.attempts"> · {{ selected.attempts }} attempt(s)</span>
          <span v-if="selected.priority !== null"> · priority {{ selected.priority }}</span>
        </p>
        <p v-if="selected.statusMessage">
          [{{ selected.statusCode }}] {{ selected.statusMessage }}
        </p>
        <h3>Request</h3>
        <XmlView v-if="selected.requestXml" :xml="selected.requestXml" />
        <p v-else class="page-sub">No request stored.</p>
        <h3>Response</h3>
        <XmlView v-if="selected.responseXml" :xml="selected.responseXml" />
        <p v-else class="page-sub">No response yet.</p>
      </template>
    </Drawer>
  </div>
</template>

<style scoped>
.commands__more {
  text-align: center;
  margin-top: 0.5rem;
}
h3 {
  font-size: 0.9rem;
  margin: 1rem 0 0.4rem;
}
</style>
