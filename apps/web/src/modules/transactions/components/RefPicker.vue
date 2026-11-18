<script setup lang="ts">
/**
 * Type-ahead picker for list references (customers, items, accounts, ...).
 * Searches the read model; Enter picks the highlighted option; typing text
 * that matches nothing clears the field on blur.
 */
import AutoComplete from 'primevue/autocomplete';
import { computed, ref, watch } from 'vue';
import { searchRefs } from '../lib/api';
import { REF_SOURCES } from '../lib/refs';
import type { RefSourceName, RefValue } from '../lib/types';

const props = withDefaults(
  defineProps<{
    modelValue: RefValue | null | undefined;
    source: RefSourceName;
    inputId?: string;
    placeholder?: string;
    invalid?: boolean;
    disabled?: boolean;
    compact?: boolean;
    ariaLabel?: string;
  }>(),
  {
    inputId: undefined,
    placeholder: undefined,
    invalid: false,
    disabled: false,
    compact: false,
    ariaLabel: undefined,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: RefValue | null];
  picked: [value: RefValue];
}>();

const inner = ref<RefValue | string | null>(props.modelValue ?? null);
const options = ref<RefValue[]>([]);
const failed = ref(false);
const multiType = computed(() => REF_SOURCES[props.source].types.length > 1);

watch(
  () => props.modelValue,
  (v) => {
    if (typeof inner.value === 'string') return;
    inner.value = v ?? null;
  },
);

let seq = 0;
async function complete(e: { query: string }) {
  const mine = ++seq;
  try {
    const found = await searchRefs(props.source, e.query);
    if (mine === seq) {
      options.value = found;
      failed.value = false;
    }
  } catch {
    if (mine === seq) {
      options.value = [];
      failed.value = true;
    }
  }
}

function onUpdate(v: unknown) {
  inner.value = (v as RefValue | string | null) ?? null;
  if (v === null || v === '' || v === undefined) emit('update:modelValue', null);
  else if (typeof v === 'object') emit('update:modelValue', v as RefValue);
}

function onSelect(e: { value: RefValue }) {
  emit('picked', e.value);
}

function typeLabel(t?: string): string {
  return (t ?? '').replace(/^Item/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}
</script>

<template>
  <AutoComplete
    :model-value="inner"
    :suggestions="options"
    option-label="FullName"
    :input-id="inputId"
    :placeholder="placeholder ?? `Choose ${REF_SOURCES[source].label}`"
    :invalid="invalid || failed"
    :disabled="disabled"
    :size="compact ? 'small' : undefined"
    :delay="200"
    :aria-label="ariaLabel"
    dropdown
    dropdown-mode="current"
    force-selection
    auto-option-focus
    append-to="body"
    fluid
    class="ref-picker"
    @update:model-value="onUpdate"
    @complete="complete"
    @option-select="onSelect"
  >
    <template #option="{ option }">
      <div class="ref-picker__option">
        <span>{{ option.FullName }}</span>
        <small v-if="multiType && option.type">{{ typeLabel(option.type) }}</small>
      </div>
    </template>
    <template #empty>
      <span class="ref-picker__empty">{{ failed ? 'Search failed' : 'No matches' }}</span>
    </template>
  </AutoComplete>
</template>

<style scoped>
.ref-picker {
  width: 100%;
}
.ref-picker__option {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}
.ref-picker__option small,
.ref-picker__empty {
  color: var(--p-text-muted-color);
}
</style>
