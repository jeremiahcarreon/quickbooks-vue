<script setup lang="ts">
/** Generic add/edit form generated from the entity's Add/Mod ObjectDef. */
import Button from 'primevue/button';
import Message from 'primevue/message';
import ProgressSpinner from 'primevue/progressspinner';
import { computed, nextTick, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import ConflictDiff from '@/components/ConflictDiff.vue';
import ObjectForm from '@/components/ObjectForm.vue';
import PendingBadge from '@/components/PendingBadge.vue';
import { fromRet, reapply } from '@/forms/model';
import { useObjectEditor } from '@/forms/useObjectEditor';
import { humanize, entityTitle } from '@/lib/labels';
import { entityDetailRoute, entityListRoute } from '@/lib/links';
import { useCommandsStore, type TrackedCommand } from '@/stores/commands';
import { useMetaStore } from '@/stores/meta';

const route = useRoute();
const router = useRouter();
const meta = useMetaStore();
const commands = useCommandsStore();

const type = computed(() => String(route.params.type));
const id = computed(() => (route.params.id ? String(route.params.id) : undefined));
const opts = computed(() => ({ entity: type.value, ...(id.value ? { id: id.value } : {}) }));
const ed = useObjectEditor(opts);

watch(opts, () => void ed.load(), { immediate: true });
watch(
  () => ed.phase.value,
  (p) => {
    if (p === 'done' && ed.savedId.value)
      void router.push(entityDetailRoute(type.value, ed.savedId.value));
    else if (p === 'done') void router.push(entityListRoute(type.value));
  },
);

const title = computed(() =>
  ed.isEdit.value
    ? `Edit ${humanize(type.value)} ${ed.original.value?.name ?? ed.original.value?.refNumber ?? ''}`.trim()
    : `New ${humanize(type.value)}`,
);
const busy = computed(() => ed.phase.value === 'submitting' || ed.phase.value === 'pending');

const cssEscape = (s: string) =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(s)
    : s.replace(/["\\]/g, '\\$&');

async function save() {
  await ed.submit();
  if (Object.keys(ed.errors.value).length) {
    await nextTick();
    const first = Object.keys(ed.errors.value)[0]!;
    const el =
      document.querySelector(`[data-field="${cssEscape(first)}"]`) ??
      document.querySelector('.gf-error');
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }
}

function cancel() {
  if (id.value) void router.push(entityDetailRoute(type.value, id.value));
  else void router.push(entityListRoute(type.value));
}

/** Conflict on this form: rebuild the draft on the current object and keep editing. */
function reapplyHere(c: TrackedCommand) {
  const current = (c.result as Record<string, unknown> | null)?.current as
    Record<string, unknown> | undefined;
  if (!current || !c.submitted || !ed.objectName.value) return;
  const ctx = meta.ctx(type.value);
  ed.value.value = reapply(ed.objectName.value, current, c.submitted, ctx);
  // the Mod diff baseline is now the current object
  ed.base.value = fromRet(ed.objectName.value, current, ctx);
  if (ed.original.value) ed.original.value = { ...ed.original.value, data: current };
  ed.note.value =
    'Your changes were reapplied on top of the latest version from QuickBooks. Review and save.';
  ed.phase.value = 'editing';
  commands.dismiss(c.id);
}
</script>

<template>
  <div class="entity-form">
    <div class="page-head">
      <RouterLink :to="entityListRoute(type)" class="page-sub">{{ entityTitle(type) }}</RouterLink>
      <span class="page-sub">/</span>
      <h1>{{ title }}</h1>
      <PendingBadge v-if="ed.command.value" :status="ed.command.value.status" />
    </div>

    <div v-if="ed.phase.value === 'loading'" class="entity-form__loading">
      <ProgressSpinner style="width: 2rem; height: 2rem" />
    </div>
    <Message v-else-if="ed.loadError.value" severity="error" :closable="false">{{
      ed.loadError.value
    }}</Message>

    <template v-else>
      <Message v-if="ed.note.value" severity="info" :closable="false">{{ ed.note.value }}</Message>
      <Message
        v-for="(g, i) in ed.general.value"
        :key="i"
        severity="error"
        :closable="false"
        data-testid="form-error"
        >{{ g }}</Message
      >
      <Message v-if="ed.phase.value === 'pending'" severity="info" :closable="false">
        Sent. Waiting for QuickBooks to confirm… You can leave this page; the tray keeps track.
      </Message>

      <div v-if="ed.phase.value === 'conflict' && ed.command.value" class="entity-form__conflict">
        <ConflictDiff :command="ed.command.value" @reapply="reapplyHere" @discard="cancel" />
      </div>

      <form v-else novalidate @submit.prevent="save">
        <ObjectForm
          v-if="ed.objectName.value"
          v-model="ed.value.value"
          :object="ed.objectName.value"
          :owner="type"
          :errors="ed.errors.value"
          :disabled="busy"
        />
        <div class="entity-form__actions">
          <Button label="Cancel" severity="secondary" text type="button" @click="cancel" />
          <Button
            :label="ed.isEdit.value ? 'Save changes' : 'Create'"
            icon="pi pi-check"
            type="submit"
            :loading="busy"
            :disabled="busy"
          />
        </div>
      </form>
    </template>
  </div>
</template>

<style scoped>
.entity-form__loading {
  padding: 2rem;
  text-align: center;
}
.entity-form__actions {
  position: sticky;
  bottom: 0;
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1.25rem;
  padding: 0.75rem 0;
  background: var(--p-surface-50);
  border-top: 1px solid var(--p-content-border-color);
}
:global(.app-dark) .entity-form__actions {
  background: var(--p-surface-950);
}
.entity-form :deep(.p-message) {
  margin-bottom: 0.75rem;
}
</style>
