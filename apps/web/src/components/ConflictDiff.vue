<script setup lang="ts">
/**
 * Conflict view for a Mod that failed with 3200 (EditSequence out of date):
 * every submitted field next to what QuickBooks has now (result.current) and,
 * when known, what it was when the edit began. "Reload and reapply" builds a
 * fresh edit from the current object with the user's changes put back.
 */
import Button from 'primevue/button';
import Message from 'primevue/message';
import { computed } from 'vue';
import { fieldDiff } from '@/forms/model';
import type { TrackedCommand } from '@/stores/commands';

const props = defineProps<{ command: TrackedCommand }>();
const emit = defineEmits<{
  reapply: [command: TrackedCommand];
  discard: [command: TrackedCommand];
}>();

const current = computed(() => {
  const r = props.command.result;
  const c = r && typeof r === 'object' ? (r as Record<string, unknown>).current : undefined;
  return c && typeof c === 'object' ? (c as Record<string, unknown>) : null;
});
const rows = computed(() =>
  current.value && props.command.submitted
    ? fieldDiff(props.command.submitted, current.value, props.command.base ?? undefined)
    : [],
);
const hasBase = computed(() => !!props.command.base);
</script>

<template>
  <div class="conflict-diff">
    <Message severity="warn" :closable="false">
      Someone changed this {{ command.entity ?? 'object' }} in QuickBooks after you started editing.
      {{ command.statusMessage }}
    </Message>
    <p v-if="!current" class="conflict-diff__missing">The current version could not be loaded.</p>
    <table v-else class="conflict-diff__table">
      <thead>
        <tr>
          <th>Field</th>
          <th v-if="hasBase">When you started</th>
          <th>Now in QuickBooks</th>
          <th>Your change</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.path"
          :class="{
            'conflict-diff__row--clash': r.changedRemotely && r.differs,
            'conflict-diff__row--same': !r.differs,
          }"
          :data-path="r.path"
        >
          <td>{{ r.label }}</td>
          <td v-if="hasBase">{{ r.base || '—' }}</td>
          <td>
            {{ r.current || '—' }}
            <i
              v-if="r.changedRemotely"
              class="pi pi-exclamation-circle"
              title="Changed by someone else"
            />
          </td>
          <td>{{ r.mine || '(cleared)' }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="hasBase ? 4 : 3">No field changes were submitted.</td>
        </tr>
      </tbody>
    </table>
    <div class="conflict-diff__actions">
      <Button
        label="Discard my change"
        severity="secondary"
        text
        @click="emit('discard', command)"
      />
      <Button
        label="Reload and reapply"
        icon="pi pi-replay"
        :disabled="!current || !command.formObject"
        @click="emit('reapply', command)"
      />
    </div>
  </div>
</template>

<style scoped>
.conflict-diff__table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.75rem 0;
  font-size: 0.9rem;
}
.conflict-diff__table th,
.conflict-diff__table td {
  text-align: left;
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: top;
}
.conflict-diff__table th {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.conflict-diff__row--clash td {
  background: color-mix(in srgb, var(--p-orange-500) 12%, transparent);
}
.conflict-diff__row--same td {
  color: var(--p-text-muted-color);
}
.conflict-diff__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.conflict-diff__missing {
  color: var(--p-text-muted-color);
}
</style>
