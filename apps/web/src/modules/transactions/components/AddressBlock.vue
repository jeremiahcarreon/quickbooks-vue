<script setup lang="ts">
/** Structured address editor (Addr1-3, City, State, Postal code). Other parts are kept as loaded. */
import type { Address } from '../lib/types';

const props = defineProps<{
  modelValue: Address | null | undefined;
  label: string;
  idPrefix: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: Address] }>();

const LINES: { key: keyof Address; label: string; max: number }[] = [
  { key: 'Addr1', label: 'Address line 1', max: 41 },
  { key: 'Addr2', label: 'Address line 2', max: 41 },
  { key: 'Addr3', label: 'Address line 3', max: 41 },
];

function set(key: keyof Address, value: string) {
  emit('update:modelValue', { ...(props.modelValue ?? {}), [key]: value });
}
</script>

<template>
  <fieldset class="addr" :disabled="disabled">
    <legend>{{ label }}</legend>
    <input
      v-for="l in LINES"
      :id="`${idPrefix}-${l.key}`"
      :key="l.key"
      class="addr__in"
      :aria-label="`${label}: ${l.label}`"
      :maxlength="l.max"
      :value="modelValue?.[l.key] ?? ''"
      @input="set(l.key, ($event.target as HTMLInputElement).value)"
    />
    <div class="addr__row">
      <input
        class="addr__in addr__city"
        :aria-label="`${label}: City`"
        placeholder="City"
        maxlength="31"
        :value="modelValue?.City ?? ''"
        @input="set('City', ($event.target as HTMLInputElement).value)"
      />
      <input
        class="addr__in addr__state"
        :aria-label="`${label}: State`"
        placeholder="State"
        maxlength="21"
        :value="modelValue?.State ?? ''"
        @input="set('State', ($event.target as HTMLInputElement).value)"
      />
      <input
        class="addr__in addr__zip"
        :aria-label="`${label}: Postal code`"
        placeholder="Zip"
        maxlength="13"
        :value="modelValue?.PostalCode ?? ''"
        @input="set('PostalCode', ($event.target as HTMLInputElement).value)"
      />
    </div>
  </fieldset>
</template>

<style scoped>
.addr {
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  padding: 0.25rem 0.5rem 0.5rem;
  margin: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.addr legend {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  padding: 0 0.25rem;
}
.addr__in {
  font: inherit;
  border: 0;
  border-bottom: 1px solid var(--p-content-border-color);
  background: transparent;
  color: var(--p-text-color);
  padding: 0.15rem 0.25rem;
  min-width: 0;
}
.addr__in:focus {
  outline: 2px solid var(--p-primary-color);
  outline-offset: -1px;
}
.addr__row {
  display: grid;
  grid-template-columns: 1fr 4rem 5.5rem;
  gap: 4px;
}
</style>
