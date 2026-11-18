<script setup lang="ts">
/** The input for one generated form field, chosen from its FormField kind. */
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import SelectButton from 'primevue/selectbutton';
import Textarea from 'primevue/textarea';
import { computed } from 'vue';
import type { ErrorMap, FormField, FormValue } from '@/forms/model';
import DateInput from './DateInput.vue';
import LineItemsEditor from './LineItemsEditor.vue';
import MoneyInput from './MoneyInput.vue';
import ObjectForm from './ObjectForm.vue';
import RefPicker from './RefPicker.vue';
import type { RefValue } from './types';

const props = withDefaults(
  defineProps<{
    field: FormField;
    modelValue?: unknown;
    /** Full path of this field (`InvoiceLineAdd[0].Rate`). */
    path: string;
    errors?: ErrorMap;
    owner?: string;
    disabled?: boolean;
    inputId?: string;
    /** Table-cell rendering: no nested sections. */
    compact?: boolean;
  }>(),
  {
    modelValue: undefined,
    errors: () => ({}),
    owner: undefined,
    disabled: false,
    inputId: undefined,
    compact: false,
  },
);
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>();

const invalid = computed(() => !!props.errors[props.path]);
const str = computed(() => {
  const v = props.modelValue;
  if (v === undefined || v === null) return '';
  if (typeof v === 'object' && '#text' in (v as object))
    return String((v as Record<string, unknown>)['#text'] ?? '');
  return String(v);
});
const enumOptions = computed(() => [
  ...(props.field.required ? [] : [{ label: '—', value: '' }]),
  ...(props.field.def.enum ?? []).map((e) => ({ label: e, value: e })),
]);
const boolOptions = [
  { label: 'Yes', value: 'true' },
  { label: 'No', value: 'false' },
];
const listText = computed(() =>
  Array.isArray(props.modelValue) ? (props.modelValue as unknown[]).join('\n') : '',
);

function set(v: unknown) {
  emit('update:modelValue', v === null || v === undefined ? '' : v);
}
function setRef(v: RefValue | null) {
  emit('update:modelValue', v ?? undefined);
}
function setList(v: string | undefined) {
  emit(
    'update:modelValue',
    (v ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
</script>

<template>
  <InputText
    v-if="
      field.kind === 'text' ||
      field.kind === 'id' ||
      field.kind === 'guid' ||
      field.kind === 'duration'
    "
    :id="inputId"
    :model-value="str"
    :maxlength="field.def.maxLength"
    :invalid="invalid"
    :disabled="disabled"
    :placeholder="
      field.kind === 'guid'
        ? '{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}'
        : field.kind === 'duration'
          ? 'PT8H30M'
          : ''
    "
    class="field-input"
    @update:model-value="set"
  />
  <Textarea
    v-else-if="field.kind === 'textarea'"
    :id="inputId"
    :model-value="str"
    :maxlength="field.def.maxLength"
    :invalid="invalid"
    :disabled="disabled"
    :rows="compact ? 1 : 3"
    auto-resize
    class="field-input"
    @update:model-value="set"
  />
  <Select
    v-else-if="field.kind === 'enum'"
    :input-id="inputId"
    :model-value="str"
    :options="enumOptions"
    option-label="label"
    option-value="value"
    :invalid="invalid"
    :disabled="disabled"
    :filter="(field.def.enum?.length ?? 0) > 10"
    class="field-input"
    @update:model-value="set"
  />
  <MoneyInput
    v-else-if="field.kind === 'money' || field.kind === 'number'"
    :input-id="inputId"
    :model-value="str || null"
    :kind="field.numberKind"
    :invalid="invalid"
    :disabled="disabled"
    @update:model-value="set"
  />
  <DateInput
    v-else-if="field.kind === 'date' || field.kind === 'datetime'"
    :input-id="inputId"
    :model-value="str || null"
    :with-time="field.kind === 'datetime'"
    :invalid="invalid"
    :disabled="disabled"
    @update:model-value="set"
  />
  <SelectButton
    v-else-if="field.kind === 'bool'"
    :model-value="str || null"
    :options="boolOptions"
    option-label="label"
    option-value="value"
    :allow-empty="!field.required"
    :invalid="invalid"
    :disabled="disabled"
    size="small"
    :aria-labelledby="inputId ? `${inputId}-label` : undefined"
    @update:model-value="set"
  />
  <RefPicker
    v-else-if="field.kind === 'ref' && field.refTargets?.length"
    :input-id="inputId"
    :model-value="(modelValue as RefValue | null) ?? null"
    :entity="field.refTargets"
    :invalid="invalid"
    :disabled="disabled"
    @update:model-value="setRef"
  />
  <InputText
    v-else-if="field.kind === 'ref'"
    :id="inputId"
    :model-value="(modelValue as RefValue | undefined)?.FullName ?? ''"
    :invalid="invalid"
    :disabled="disabled"
    placeholder="Full name"
    class="field-input"
    @update:model-value="(v) => setRef(v ? { FullName: v } : null)"
  />
  <Textarea
    v-else-if="field.kind === 'list'"
    :id="inputId"
    :model-value="listText"
    :invalid="invalid"
    :disabled="disabled"
    rows="2"
    placeholder="One per line"
    class="field-input"
    @update:model-value="setList"
  />
  <ObjectForm
    v-else-if="field.kind === 'object' && !compact"
    :model-value="(modelValue as FormValue | undefined) ?? {}"
    :object="field.child!"
    :owner="owner"
    :errors="errors"
    :path="`${path}.`"
    :disabled="disabled"
    nested
    @update:model-value="set"
  />
  <LineItemsEditor
    v-else-if="field.kind === 'lines' && !compact"
    :model-value="(modelValue as FormValue[] | undefined) ?? []"
    :object="field.child!"
    :owner="owner"
    :errors="errors"
    :path="path"
    :disabled="disabled"
    :max-rows="field.maxOccurs ?? undefined"
    @update:model-value="set"
  />
  <span v-else class="field-input__unsupported">Edit in the row details</span>
</template>

<style scoped>
.field-input {
  width: 100%;
}
.field-input__unsupported {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
</style>
