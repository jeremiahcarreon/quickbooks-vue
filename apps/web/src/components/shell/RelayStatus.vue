<script setup lang="ts">
/** Relay / live-update indicator in the top bar. */
import { computed } from 'vue';
import { useEventsStore } from '@/stores/events';

const events = useEventsStore();

const state = computed(() => {
  if (events.status === 'reconnecting' || events.status === 'connecting') {
    return { tone: 'warn', label: 'Reconnecting', title: 'Live updates are reconnecting…' };
  }
  if (events.relayConnected === true) {
    return {
      tone: 'ok',
      label: 'QuickBooks',
      title: 'QuickBooks relay connected; live updates on',
    };
  }
  if (events.relayConnected === false) {
    return {
      tone: 'bad',
      label: 'QuickBooks offline',
      title: `QuickBooks relay unreachable${events.relayError ? `: ${events.relayError}` : ''}. Writes wait in the queue.`,
    };
  }
  return { tone: 'unknown', label: 'QuickBooks', title: 'Relay status unknown' };
});
</script>

<template>
  <button
    type="button"
    class="relay-status"
    :class="`relay-status--${state.tone}`"
    :title="state.title"
    :aria-label="state.title"
    data-testid="relay-status"
    @click="events.refreshHealth()"
  >
    <span class="relay-status__dot" aria-hidden="true" />
    <span class="relay-status__label">{{ state.label }}</span>
  </button>
</template>

<style scoped>
.relay-status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border: 1px solid var(--p-content-border-color);
  background: transparent;
  color: var(--p-text-color);
  border-radius: 999px;
  padding: 0.2rem 0.6rem;
  font-size: 0.8rem;
  cursor: pointer;
}
.relay-status__dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: var(--p-surface-400);
}
.relay-status--ok .relay-status__dot {
  background: var(--p-green-500);
}
.relay-status--bad .relay-status__dot {
  background: var(--p-red-500);
}
.relay-status--warn .relay-status__dot {
  background: var(--p-orange-400);
  animation: pulse 1.2s infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
@media (max-width: 768px) {
  .relay-status__label {
    display: none;
  }
}
</style>
