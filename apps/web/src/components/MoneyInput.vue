<script setup lang="ts">
/**
 * Decimal input for qbXML numeric types. The model is the exact decimal
 * string (never a float), normalised on blur for the type: AMTTYPE gets two
 * decimals ("12.5" -> "12.50"), the others keep up to five.
 */
import InputText from 'primevue/inputtext';
import InputGroup from 'primevue/inputgroup';
import InputGroupAddon from 'primevue/inputgroupaddon';
import { computed, ref, watch } from 'vue';
import { normalizeNumber, type NumberKind } from '@/forms/model';
import { formatMoney } from '@/lib/format';

const props = withDefaults(
  defineProps<{
    modelValue?: string | null;
    kind?: NumberKind;
    currency?: boolean;
    invalid?: boolean;
    disabled?: boolean;
    placeholder?: string;
    inputId?: string;
  }>(),
  {
    modelValue: null,
    kind: 'amount',
    currency: false,
    invalid: false,
    disabled: false,
    placeholder: '',
    inputId: undefined,
  },
);
const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>();

const focused = ref(false);
const text = ref(props.modelValue ?? '');
watch(
  () => props.modelValue,
  (v) => {
    if (!focused.value) text.value = v ?? '';
  },
);

const display = computed(() => {
  if (focused.value) return text.value;
  if (props.kind === 'amount' && /^[+-]?\d+(\.\d+)?$/.test(text.value))
    return formatMoney(text.value);
  return text.value;
});

function onInput(v: string | undefined) {
  // keep digits, sign, one dot (commas are ignored)
  const cleaned = (v ?? '').replace(/[^\d.+-]/g, '');
  text.value = cleaned;
  emit('update:modelValue', cleaned === '' ? null : cleaned);
}

function onBlur() {
  focused.value = false;
  if (text.value === '') return;
  const n = normalizeNumber(text.value, props.kind);
  if (n !== text.value) {
    text.value = n;
    emit('update:modelValue', n);
  }
}
</script>

<template>
  <InputGroup v-if="currency && kind === 'amount'" class="money-input">
    <InputGroupAddon>$</InputGroupAddon>
    <InputText
      :id="inputId"
      :model-value="display"
      inputmode="decimal"
      class="money-input__field"
      :invalid="invalid"
      :disabled="disabled"
      :placeholder="placeholder"
      @update:model-value="onInput"
      @focus="focused = true"
      @blur="onBlur"
    />
  </InputGroup>
  <InputText
    v-else
    :id="inputId"
    :model-value="display"
    inputmode="decimal"
    class="money-input__field"
    :invalid="invalid"
    :disabled="disabled"
    :placeholder="placeholder"
    @update:model-value="onInput"
    @focus="focused = true"
    @blur="onBlur"
  />
</template>

<style scoped>
.money-input__field {
  text-align: right;
  font-variant-numeric: tabular-nums;
  width: 100%;
}
</style>
