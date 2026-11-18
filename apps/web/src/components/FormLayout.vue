<script setup lang="ts">
/** Renders a layout (fields and choice groups) of a generated form. Recursive for nested choices. */
import SelectButton from 'primevue/selectbutton';
import { computed } from 'vue';
import {
  selectedBranch,
  type ChoiceItem,
  type ErrorMap,
  type FormField,
  type FormValue,
  type LayoutItem,
} from '@/forms/model';
import FieldInput from './FieldInput.vue';

const props = withDefaults(
  defineProps<{
    items: LayoutItem[];
    value: FormValue;
    path?: string;
    errors?: ErrorMap;
    owner?: string;
    disabled?: boolean;
    exclude?: string[];
  }>(),
  { path: '', errors: () => ({}), owner: undefined, disabled: false, exclude: () => [] },
);
const emit = defineEmits<{
  set: [name: string, value: unknown];
  choose: [id: string, index: number];
}>();

const shown = computed(() =>
  props.items.filter(
    (it) => it.type === 'choice' || (!it.field.hidden && !props.exclude.includes(it.field.name)),
  ),
);

const WIDE = new Set(['object', 'lines', 'textarea', 'list']);
const idOf = (f: FormField) => `fld-${props.path}${f.name}`.replace(/[^\w-]/g, '_');

function branchOptions(c: ChoiceItem) {
  return [
    ...c.branches.map((b) => ({ label: b.label || `Option ${b.index + 1}`, value: b.index })),
    ...(c.required ? [] : [{ label: 'None', value: -1 }]),
  ];
}
function branchItems(c: ChoiceItem): LayoutItem[] {
  const b = selectedBranch(c, props.value);
  return c.branches.find((x) => x.index === b)?.items ?? [];
}
function hint(f: FormField): string {
  if (f.def.maxLength && (f.kind === 'text' || f.kind === 'textarea'))
    return `max ${f.def.maxLength}`;
  return '';
}
</script>

<template>
  <template v-for="it in shown" :key="it.type === 'field' ? it.field.name : `#${it.id}`">
    <div
      v-if="it.type === 'field'"
      class="gf-field"
      :class="{
        'gf-field--wide': WIDE.has(it.field.kind),
        'gf-field--section': it.field.kind === 'object' || it.field.kind === 'lines',
      }"
      :data-field="`${path}${it.field.name}`"
    >
      <label :id="`${idOf(it.field)}-label`" :for="idOf(it.field)" class="gf-label">
        {{ it.field.label
        }}<span v-if="it.field.required" class="gf-req" aria-label="required">*</span>
        <small v-if="hint(it.field)" class="gf-hint">{{ hint(it.field) }}</small>
      </label>
      <FieldInput
        :field="it.field"
        :model-value="value[it.field.name]"
        :path="`${path}${it.field.name}`"
        :errors="errors"
        :owner="owner"
        :disabled="disabled"
        :input-id="idOf(it.field)"
        @update:model-value="(v) => emit('set', it.field.name, v)"
      />
      <small v-if="errors[`${path}${it.field.name}`]" class="gf-error" role="alert">
        {{ errors[`${path}${it.field.name}`] }}
      </small>
    </div>
    <fieldset v-else class="gf-choice" :data-choice="`${path}#${it.id}`">
      <legend class="gf-label">
        One of<span v-if="it.required" class="gf-req" aria-label="required">*</span>
      </legend>
      <SelectButton
        :model-value="selectedBranch(it, value)"
        :options="branchOptions(it)"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        :disabled="disabled"
        size="small"
        @update:model-value="(i: number) => emit('choose', it.id, i)"
      />
      <small v-if="errors[`${path}#${it.id}`]" class="gf-error" role="alert">{{
        errors[`${path}#${it.id}`]
      }}</small>
      <div class="gf-grid">
        <FormLayout
          :items="branchItems(it)"
          :value="value"
          :path="path"
          :errors="errors"
          :owner="owner"
          :disabled="disabled"
          :exclude="exclude"
          @set="(n, v) => emit('set', n, v)"
          @choose="(id, i) => emit('choose', id, i)"
        />
      </div>
    </fieldset>
  </template>
</template>
