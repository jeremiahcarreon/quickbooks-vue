<script setup lang="ts">
/** Generic detail page: every field of the Ret, lines as tables, refs as links, plus write actions. */
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import Dialog from 'primevue/dialog';
import Message from 'primevue/message';
import Select from 'primevue/select';
import Skeleton from 'primevue/skeleton';
import ToggleButton from 'primevue/togglebutton';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import { objectsApi } from '@/api/endpoints';
import type { CommandStatus, QbObject } from '@/api/types';
import ObjectView from '@/components/ObjectView.vue';
import PendingBadge from '@/components/PendingBadge.vue';
import RefPicker from '@/components/RefPicker.vue';
import type { RefValue } from '@/components/types';
import { MERGEABLE_ENTITIES } from '@/lib/entities';
import { formatDate } from '@/lib/format';
import { entityTitle, humanize } from '@/lib/labels';
import { entityDetailRoute, entityEditRoute, entityListRoute } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';
import { useCommandsStore } from '@/stores/commands';
import { useEventsStore } from '@/stores/events';
import { useMetaStore } from '@/stores/meta';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const meta = useMetaStore();
const events = useEventsStore();
const commands = useCommandsStore();
const confirm = useConfirm();
const toast = useToast();

const type = computed(() => String(route.params.type));
const id = computed(() => String(route.params.id));
const def = computed(() => meta.entity(type.value));
const obj = ref<QbObject | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const showRaw = ref(false);

async function load() {
  loading.value = !obj.value;
  error.value = null;
  try {
    await meta.loadEntity(type.value).catch(() => undefined);
    obj.value = await objectsApi.get(type.value, id.value);
    if (typeof document !== 'undefined') document.title = `${title.value} · QuickBooks Vue`;
  } catch (err) {
    obj.value = null;
    error.value =
      err instanceof ApiError && err.status === 404
        ? 'Not found in the read model. It may have been deleted, or not synced yet.'
        : (err as Error).message;
  } finally {
    loading.value = false;
  }
}
watch([type, id], load, { immediate: true });
watch(
  () => events.lastChange[`${type.value}:${id.value}`],
  (c) => {
    if (c) void load();
  },
);

const title = computed(() => {
  const o = obj.value;
  if (!o) return humanize(type.value);
  if (def.value?.category === 'txn') return `${humanize(type.value)} ${o.refNumber ?? ''}`.trim();
  return o.name ?? humanize(type.value);
});
const deleted = computed(() => !!obj.value?.deletedAt);
const writable = computed(() => auth.canWrite(type.value) && !deleted.value);
const canEdit = computed(() => writable.value && !!def.value?.ops.mod);
const canDelete = computed(() => writable.value && !!def.value?.ops.del);
const canVoid = computed(() => writable.value && !!def.value?.ops.void);
const pending = computed(() => commands.pendingFor(type.value, id.value));
const canMerge = computed(
  () =>
    writable.value && def.value?.idField === 'ListID' && MERGEABLE_ENTITIES.includes(type.value),
);
const canClear = computed(() => writable.value && def.value?.idField === 'TxnID');

// ---- merge (ListMergeRq) and cleared status (ClearedStatusModRq)
const mergeOpen = ref(false);
const mergeInto = ref<RefValue | null>(null);
const sameShipAddrOk = ref(false);
const clearOpen = ref(false);
const clearedStatus = ref<'Cleared' | 'NotCleared' | 'Pending'>('Cleared');
const CLEARED_OPTIONS = [
  { label: 'Cleared', value: 'Cleared' },
  { label: 'Not cleared', value: 'NotCleared' },
  { label: 'Pending', value: 'Pending' },
];
const actionBusy = ref(false);

async function queued(
  label: string,
  send: () => Promise<{ id: string; status: CommandStatus }>,
  objectId: string,
) {
  actionBusy.value = true;
  try {
    const ref = await send();
    commands.track({
      id: ref.id,
      status: ref.status,
      op: 'raw',
      entity: type.value,
      objectId,
      label,
    });
    toast.add({
      severity: 'info',
      summary: `${label} queued`,
      detail: 'Waiting for QuickBooks…',
      life: 3000,
    });
    return ref;
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: `${label} failed`,
      detail: (err as Error).message,
      life: 6000,
    });
    return null;
  } finally {
    actionBusy.value = false;
  }
}

async function merge() {
  const into = mergeInto.value?.ListID;
  if (!into || into === id.value) return;
  const label = `Merge ${title.value} into ${mergeInto.value?.FullName ?? into}`;
  const ok = await queued(
    label,
    () => objectsApi.merge(type.value, id.value, into, sameShipAddrOk.value || undefined),
    into,
  );
  if (ok) {
    mergeOpen.value = false;
    void commands.waitFor(ok.id).then((done) => {
      if (done.status === 'succeeded' && route.params.id === id.value)
        void router.push(entityDetailRoute(type.value, into));
    });
  }
}

async function setCleared() {
  const ok = await queued(
    `Mark ${title.value} ${clearedStatus.value}`,
    () => objectsApi.clearedStatus(type.value, id.value, clearedStatus.value),
    id.value,
  );
  if (ok) clearOpen.value = false;
}

function runOp(op: 'del' | 'void') {
  const verb = op === 'del' ? 'Delete' : 'Void';
  confirm.require({
    header: `${verb} ${title.value}?`,
    message:
      op === 'del'
        ? 'This deletes it in QuickBooks. It cannot be undone here.'
        : 'This voids the transaction in QuickBooks (amounts become zero; the record stays).',
    acceptProps: { label: verb, severity: 'danger' },
    rejectProps: { label: 'Cancel', severity: 'secondary', text: true },
    accept: async () => {
      try {
        const c = await commands.submit({
          op,
          entity: type.value,
          id: id.value,
          label: `${verb} ${title.value}`,
        });
        toast.add({
          severity: 'info',
          summary: `${verb} queued`,
          detail: 'Waiting for QuickBooks…',
          life: 3000,
        });
        if (op === 'del') {
          void commands.waitFor(c.id).then((done) => {
            if (done.status === 'succeeded' && route.params.id === id.value)
              void router.push(entityListRoute(type.value));
          });
        }
      } catch (err) {
        toast.add({
          severity: 'error',
          summary: `${verb} failed`,
          detail: (err as Error).message,
          life: 6000,
        });
      }
    },
  });
}
</script>

<template>
  <div>
    <div class="page-head">
      <RouterLink :to="entityListRoute(type)" class="page-sub">{{ entityTitle(type) }}</RouterLink>
      <span class="page-sub">/</span>
      <h1>{{ title }}</h1>
      <PendingBadge :id="id" :entity="type" />
      <span v-if="deleted" class="page-sub">(deleted)</span>
      <div class="page-head__spacer" />
      <ToggleButton
        v-model="showRaw"
        on-label="Fields"
        off-label="Raw"
        on-icon="pi pi-list"
        off-icon="pi pi-code"
        size="small"
      />
      <Button
        v-if="canClear"
        label="Cleared status"
        icon="pi pi-check-square"
        severity="secondary"
        size="small"
        text
        data-testid="cleared-open"
        @click="clearOpen = true"
      />
      <Button
        v-if="canMerge"
        label="Merge"
        icon="pi pi-sitemap"
        severity="secondary"
        size="small"
        text
        data-testid="merge-open"
        @click="mergeOpen = true"
      />
      <Button
        v-if="canVoid"
        label="Void"
        icon="pi pi-ban"
        severity="secondary"
        size="small"
        text
        @click="runOp('void')"
      />
      <Button
        v-if="canDelete"
        label="Delete"
        icon="pi pi-trash"
        severity="danger"
        size="small"
        text
        @click="runOp('del')"
      />
      <Button
        v-if="canEdit"
        label="Edit"
        icon="pi pi-pencil"
        size="small"
        :disabled="pending?.status === 'queued' || pending?.status === 'sending'"
        @click="router.push(entityEditRoute(type, id))"
      />
    </div>
    <Message
      v-if="pending?.statusMessage"
      :severity="pending.status === 'conflict' ? 'warn' : 'error'"
      :closable="false"
    >
      {{ pending.statusMessage }}
    </Message>
    <Message v-if="error" severity="warn" :closable="false">{{ error }}</Message>
    <div v-if="loading" class="detail__skeleton">
      <Skeleton v-for="n in 6" :key="n" height="1.5rem" />
    </div>
    <template v-else-if="obj">
      <p class="page-sub">
        <span v-if="obj.timeModified">Modified {{ formatDate(obj.timeModified) }}</span>
        <span v-if="obj.editSequence"> · edit sequence {{ obj.editSequence }}</span>
      </p>
      <pre v-if="showRaw" class="xml-view xml-code">{{ JSON.stringify(obj.data, null, 2) }}</pre>
      <ObjectView v-else :data="obj.data" :object="def?.retElement" :owner="type" />
    </template>
    <Dialog
      v-model:visible="mergeOpen"
      modal
      :header="`Merge ${title}`"
      :style="{ width: '32rem' }"
    >
      <p>
        Every transaction that uses {{ title }} is moved to the record you pick, and {{ title }} is
        removed from QuickBooks. This cannot be undone here.
      </p>
      <label class="detail__label" for="merge-into">Merge into</label>
      <RefPicker
        v-model="mergeInto"
        :entity="type"
        input-id="merge-into"
        data-testid="merge-into"
      />
      <label v-if="type === 'Customer' || type === 'Vendor'" class="detail__check">
        <Checkbox v-model="sameShipAddrOk" binary />
        Both have the same ship-to address (required by QuickBooks when they differ only there)
      </label>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="mergeOpen = false" />
        <Button
          label="Merge"
          severity="danger"
          :disabled="!mergeInto?.ListID || mergeInto.ListID === id"
          :loading="actionBusy"
          data-testid="merge-submit"
          @click="merge"
        />
      </template>
    </Dialog>
    <Dialog v-model:visible="clearOpen" modal header="Cleared status" :style="{ width: '24rem' }">
      <p>Sets the cleared status of {{ title }} in QuickBooks (as in the check register).</p>
      <Select
        v-model="clearedStatus"
        :options="CLEARED_OPTIONS"
        option-label="label"
        option-value="value"
        data-testid="cleared-status"
      />
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="clearOpen = false" />
        <Button
          label="Save"
          :loading="actionBusy"
          data-testid="cleared-submit"
          @click="setCleared"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.detail__label {
  display: block;
  margin: 0.75rem 0 0.25rem;
  font-weight: 600;
}
.detail__check {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.75rem;
}
.detail__skeleton {
  display: grid;
  gap: 0.5rem;
  max-width: 40rem;
}
</style>
