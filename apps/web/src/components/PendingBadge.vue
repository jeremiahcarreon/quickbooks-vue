<script setup lang="ts">
/**
 * Shows the state of an unresolved write for one object (or an explicit
 * status). Renders nothing when there is nothing pending.
 */
import Tag from 'primevue/tag';
import { computed } from 'vue';
import type { CommandStatus } from '@/api/types';
import { useCommandsStore } from '@/stores/commands';
import { trayBus } from './trayBus';

const props = withDefaults(
  defineProps<{ entity?: string; id?: string; status?: CommandStatus | null }>(),
  { entity: undefined, id: undefined, status: null },
);

const commands = useCommandsStore();
const cmd = computed(() =>
  props.entity && props.id ? commands.pendingFor(props.entity, props.id) : undefined,
);
const effective = computed<CommandStatus | null>(() => props.status ?? cmd.value?.status ?? null);

const LOOK: Record<CommandStatus, { label: string; severity: string; icon: string }> = {
  queued: { label: 'Pending', severity: 'info', icon: 'pi pi-clock' },
  sending: { label: 'Saving', severity: 'info', icon: 'pi pi-spin pi-spinner' },
  succeeded: { label: 'Saved', severity: 'success', icon: 'pi pi-check' },
  failed: { label: 'Failed', severity: 'danger', icon: 'pi pi-times-circle' },
  rejected: { label: 'Rejected', severity: 'danger', icon: 'pi pi-ban' },
  conflict: { label: 'Conflict', severity: 'warn', icon: 'pi pi-exclamation-triangle' },
};
const look = computed(() => (effective.value ? LOOK[effective.value] : null));

function open() {
  trayBus.open(cmd.value?.id);
}
</script>

<template>
  <Tag
    v-if="look"
    :value="look.label"
    :severity="look.severity"
    :icon="look.icon"
    class="pending-badge"
    role="button"
    :title="cmd?.statusMessage ?? look.label"
    @click.stop="open"
  />
</template>

<style scoped>
.pending-badge {
  cursor: pointer;
  font-size: 0.75rem;
}
</style>
