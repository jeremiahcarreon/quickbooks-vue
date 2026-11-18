<script setup lang="ts">
/** Totals footer. Figures are estimates until QuickBooks confirms the transaction. */
import type { TotalRow } from '../lib/types';

defineProps<{ rows: TotalRow[] }>();
</script>

<template>
  <dl class="totals" aria-label="Totals">
    <template v-for="r in rows" :key="r.label">
      <dt :class="{ 'totals--strong': r.strong }">{{ r.label }}</dt>
      <dd :class="{ 'totals--strong': r.strong }" :title="r.hint">{{ r.value }}</dd>
    </template>
  </dl>
</template>

<style scoped>
.totals {
  display: grid;
  grid-template-columns: auto minmax(8rem, auto);
  gap: 0.25rem 1.25rem;
  margin: 0;
  justify-content: end;
  align-content: start;
}
.totals dt {
  color: var(--p-text-muted-color);
  text-align: right;
}
.totals dd {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.totals--strong {
  font-weight: 700;
  font-size: 1.1rem;
  color: var(--p-text-color) !important;
  border-top: 1px solid var(--p-content-border-color);
  padding-top: 0.25rem;
}
</style>
