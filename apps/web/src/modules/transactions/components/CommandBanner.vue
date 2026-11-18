<script setup lang="ts">
/**
 * Shows where a write is: pending in the queue, confirmed by QuickBooks,
 * rejected, or in conflict (someone changed the transaction first). For a
 * conflict it lists the fields that differ and offers "reload & reapply".
 */
import Button from 'primevue/button';
import Message from 'primevue/message';
import ProgressSpinner from 'primevue/progressspinner';
import { computed } from 'vue';
import type { CommandView } from '../lib/api';
import type { DiffRow } from '../lib/diff';
import type { Phase } from '../lib/useCommand';

const props = defineProps<{
  phase: Phase;
  command: CommandView | null;
  error: string | null;
  issues?: string[];
  diff?: DiffRow[];
  /** What was saved, e.g. "Invoice 1001". */
  subject?: string;
}>();
const emit = defineEmits<{ reapply: []; discard: []; dismiss: [] }>();

const statusLabel = computed(() => {
  const s = props.command?.status;
  if (s === 'sending') return 'Sending to QuickBooks...';
  if (props.phase === 'submitting') return 'Submitting...';
  return 'Queued for QuickBooks...';
});
</script>

<template>
  <div class="banner" aria-live="polite">
    <Message v-if="issues && issues.length" severity="warn" :closable="false">
      <ul class="banner__list">
        <li v-for="(i, n) in issues" :key="n">{{ i }}</li>
      </ul>
    </Message>
    <Message v-if="phase === 'submitting' || phase === 'pending'" severity="info" :closable="false">
      <span class="banner__row">
        <ProgressSpinner style="width: 1rem; height: 1rem" stroke-width="6" aria-hidden="true" />
        <span>
          <strong>Pending.</strong> {{ statusLabel }}
          <small v-if="command?.id" class="banner__muted"
            >Command {{ command.id.slice(0, 8) }}</small
          >
        </span>
      </span>
    </Message>
    <Message
      v-else-if="phase === 'confirmed'"
      severity="success"
      :closable="true"
      @close="emit('dismiss')"
    >
      <strong>Confirmed.</strong> QuickBooks recorded {{ subject ?? 'the transaction' }}.
      <span v-if="command?.statusCode && command.statusCode > 0" class="banner__muted">
        ({{ command.statusCode }}: {{ command.statusMessage }})
      </span>
    </Message>
    <Message
      v-else-if="phase === 'failed'"
      severity="error"
      :closable="true"
      @close="emit('dismiss')"
    >
      <strong>Not saved.</strong> {{ error }}
      <span v-if="command?.statusCode" class="banner__muted"
        >(QuickBooks status {{ command.statusCode }})</span
      >
    </Message>
    <Message v-else-if="phase === 'conflict'" severity="warn" :closable="false">
      <div class="banner__conflict">
        <div>
          <strong>Conflict.</strong> Someone changed this transaction in QuickBooks after you opened
          it. Your changes were not saved.
        </div>
        <table v-if="diff && diff.length" class="banner__diff">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Yours</th>
              <th scope="col">In QuickBooks now</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in diff" :key="d.field">
              <td>{{ d.label }}</td>
              <td>{{ d.mine || '(blank)' }}</td>
              <td>{{ d.theirs || '(blank)' }}</td>
            </tr>
          </tbody>
        </table>
        <div class="banner__actions">
          <Button
            size="small"
            label="Reload & reapply my changes"
            icon="pi pi-refresh"
            @click="emit('reapply')"
          />
          <Button
            size="small"
            severity="secondary"
            label="Discard mine, show theirs"
            @click="emit('discard')"
          />
        </div>
      </div>
    </Message>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.banner__row {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.banner__muted {
  color: var(--p-text-muted-color);
  margin-left: 0.4rem;
}
.banner__list {
  margin: 0;
  padding-left: 1.1rem;
}
.banner__conflict {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.banner__diff {
  border-collapse: collapse;
  font-size: 0.9rem;
}
.banner__diff th,
.banner__diff td {
  text-align: left;
  padding: 0.15rem 0.75rem 0.15rem 0;
}
.banner__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
