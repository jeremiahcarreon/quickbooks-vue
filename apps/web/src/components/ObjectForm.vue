<script setup lang="ts">
/**
 * Generic form for any catalog ObjectDef (CustomerAdd, InvoiceMod,
 * BillAddress, InvoiceLineAdd, ...). The ObjectDef must be in the meta store.
 * Emits a new value object on every change (v-model).
 */
import { computed } from 'vue';
import { describeObject, selectBranch, type ErrorMap, type FormValue } from '@/forms/model';
import { useMetaStore } from '@/stores/meta';
import FormLayout from './FormLayout.vue';

const props = withDefaults(
  defineProps<{
    modelValue: FormValue;
    object: string;
    owner?: string;
    errors?: ErrorMap;
    /** Prefix of this object's field paths (`BillAddress.`, `InvoiceLineAdd[2].`). */
    path?: string;
    disabled?: boolean;
    /** Fields rendered elsewhere (e.g. as line-item columns). */
    exclude?: string[];
    nested?: boolean;
  }>(),
  {
    owner: undefined,
    errors: () => ({}),
    path: '',
    disabled: false,
    exclude: () => [],
    nested: false,
  },
);
const emit = defineEmits<{ 'update:modelValue': [value: FormValue] }>();

const meta = useMetaStore();
const form = computed(() => {
  try {
    return describeObject(props.object, meta.ctx(props.owner));
  } catch {
    return null;
  }
});

function set(name: string, v: unknown) {
  emit('update:modelValue', { ...props.modelValue, [name]: v });
}
function choose(id: string, index: number) {
  const next = { ...props.modelValue };
  selectBranch(next, id, index);
  emit('update:modelValue', next);
}
</script>

<template>
  <div class="gf-grid" :class="{ 'gf-grid--nested': nested }" :data-object="object">
    <FormLayout
      v-if="form"
      :items="form.layout"
      :value="modelValue"
      :path="path"
      :errors="errors"
      :owner="owner"
      :disabled="disabled"
      :exclude="exclude"
      @set="set"
      @choose="choose"
    />
    <p v-else class="gf-missing">Form definition {{ object }} is not loaded.</p>
  </div>
</template>
