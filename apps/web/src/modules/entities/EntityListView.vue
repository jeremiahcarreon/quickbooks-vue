<script setup lang="ts">
import Button from 'primevue/button';
import Message from 'primevue/message';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { QbObject } from '@/api/types';
import QbDataTable from '@/components/QbDataTable.vue';
import { entityTitle } from '@/lib/labels';
import { entityDetailRoute, entityNewRoute } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';
import { useMetaStore } from '@/stores/meta';
import LiveQueryPanel from './LiveQueryPanel.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const meta = useMetaStore();

const type = computed(() => String(route.params.type));
const def = computed(() => meta.entity(type.value));
const error = ref<string | null>(null);
const total = ref<number | null>(null);

watch(
  type,
  (t) => {
    error.value = null;
    if (typeof document !== 'undefined') document.title = `${entityTitle(t)} · QuickBooks Vue`;
    meta.loadEntity(t).catch((e: Error) => (error.value = e.message));
  },
  { immediate: true },
);

const canAdd = computed(() => !!def.value?.ops.add && auth.canWrite(type.value));
/** Entities sync cannot load (their query needs filters) are read with a live query. */
const liveOnly = computed(() => def.value?.syncable === false);
function open(row: QbObject) {
  void router.push(entityDetailRoute(type.value, row.id));
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ entityTitle(type) }}</h1>
      <span v-if="liveOnly" class="page-sub">live from QuickBooks</span>
      <span v-else-if="total !== null" class="page-sub">{{ total }} in the read model</span>
      <div class="page-head__spacer" />
      <Button
        v-if="canAdd"
        label="New"
        icon="pi pi-plus"
        size="small"
        @click="router.push(entityNewRoute(type))"
      />
    </div>
    <Message v-if="error" severity="warn" :closable="false">{{ error }}</Message>
    <LiveQueryPanel v-if="liveOnly && def" :key="`live-${type}`" :entity="def" />
    <QbDataTable
      v-else
      :key="type"
      :entity="type"
      :state-key="`entity.${type}`"
      @row-click="open"
      @loaded="(p) => (total = p.total)"
    />
  </div>
</template>
