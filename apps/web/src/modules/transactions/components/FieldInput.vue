<script setup lang="ts">
/** One header field, rendered by kind. Numbers are normalised on blur. */
import { computed } from 'vue';
import { normAmount, normPrice } from '../lib/decimal';
import type { Address, HeaderField, RefValue } from '../lib/types';
import AddressBlock from './AddressBlock.vue';
import RefPicker from './RefPicker.vue';

const props = defineProps<{
  field: HeaderField;
  modelValue: unknown;
  inputId: string;
  maxLength?: number;
  options?: string[];
  invalid?: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: unknown];
  picked: [value: RefValue];
}>();

const asAddress = (v: unknown): Address | undefined =>
  v && typeof v === 'object' ? (v as Address) : undefined;
const asRef = (v: unknown): RefValue | null =>
  v && typeof v === 'object' ? (v as RefValue) : null;
const text = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : ''));
const numeric = computed(() => ['amount', 'price', 'qty'].includes(props.field.kind));

function onBlurNumber(e: Event) {
  const raw = (e.target as HTMLInputElement).value;
  if (!raw.trim()) return;
  const v = props.field.kind === 'amount' ? normAmount(raw) : normPrice(raw);
  if (v) emit('update:modelValue', v);
}
</script>

<template>
  <div class="fi" :class="[`fi--${field.kind}`, { 'fi--invalid': invalid }]">
    <template v-if="field.kind === 'address'">
      <AddressBlock
        :model-value="asAddress(modelValue)"
        :label="field.label"
        :id-prefix="inputId"
        :disabled="disabled"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </template>
    <template v-else-if="field.kind === 'bool'">
      <label class="fi__check">
        <input
          :id="inputId"
          type="checkbox"
          :checked="modelValue === true"
          :disabled="disabled"
          @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ field.label }}</span>
      </label>
    </template>
    <template v-else>
      <label :for="inputId" class="fi__label">
        {{ field.label }}<span v-if="field.required" class="fi__req" aria-hidden="true">*</span>
      </label>
      <RefPicker
        v-if="field.kind === 'ref' && field.ref"
        :model-value="asRef(modelValue)"
        :source="field.ref"
        :input-id="inputId"
        :invalid="invalid"
        :disabled="disabled"
        compact
        @update:model-value="emit('update:modelValue', $event)"
        @picked="emit('picked', $event)"
      />
      <input
        v-else-if="field.kind === 'date'"
        :id="inputId"
        type="date"
        class="fi__in"
        :value="text"
        :disabled="disabled"
        :aria-invalid="invalid || undefined"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <textarea
        v-else-if="field.kind === 'textarea'"
        :id="inputId"
        class="fi__in fi__area"
        rows="2"
        :maxlength="maxLength"
        :value="text"
        :disabled="disabled"
        :aria-invalid="invalid || undefined"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      />
      <select
        v-else-if="field.kind === 'enum'"
        :id="inputId"
        class="fi__in"
        :value="text"
        :disabled="disabled"
        @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
      >
        <option value="" />
        <option v-for="o in options ?? field.options ?? []" :key="o" :value="o">{{ o }}</option>
      </select>
      <input
        v-else
        :id="inputId"
        class="fi__in"
        :class="{ fi__num: numeric }"
        :inputmode="numeric ? 'decimal' : undefined"
        :maxlength="numeric ? undefined : maxLength"
        :value="text"
        :disabled="disabled"
        :aria-invalid="invalid || undefined"
        autocomplete="off"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        @blur="numeric && onBlurNumber($event)"
      />
    </template>
  </div>
</template>

<style scoped>
.fi {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.fi__label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.fi__req {
  color: var(--p-red-500);
  margin-left: 0.15rem;
}
.fi__in {
  font: inherit;
  padding: 0.3rem 0.45rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
  color: var(--p-text-color);
  min-width: 0;
}
.fi__in:focus {
  outline: 2px solid var(--p-primary-color);
  outline-offset: -1px;
}
.fi__num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.fi__area {
  resize: vertical;
}
.fi--invalid .fi__in {
  border-color: var(--p-red-500);
}
.fi__check {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding-top: 1.1rem;
}
</style>
