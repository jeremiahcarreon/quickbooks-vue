<script setup lang="ts">
/** Date picker bound to a qbXML date string (`YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm:ss` with withTime). */
import DatePicker from 'primevue/datepicker';
import { computed } from 'vue';
import { formatQbDate, parseQbDate } from '@/lib/dates';

const props = withDefaults(
  defineProps<{
    modelValue?: string | null;
    withTime?: boolean;
    invalid?: boolean;
    disabled?: boolean;
    placeholder?: string;
    inputId?: string;
  }>(),
  {
    modelValue: null,
    withTime: false,
    invalid: false,
    disabled: false,
    placeholder: '',
    inputId: undefined,
  },
);
const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>();

const value = computed(() => parseQbDate(props.modelValue));

function onUpdate(v: unknown) {
  if (v instanceof Date && !Number.isNaN(v.getTime()))
    emit('update:modelValue', formatQbDate(v, props.withTime));
  else if (v === null || v === undefined || v === '') emit('update:modelValue', null);
}
</script>

<template>
  <DatePicker
    :input-id="inputId"
    :model-value="value"
    date-format="yy-mm-dd"
    :show-time="withTime"
    hour-format="24"
    show-icon
    icon-display="input"
    show-button-bar
    :invalid="invalid"
    :disabled="disabled"
    :placeholder="placeholder || (withTime ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD')"
    class="date-input"
    @update:model-value="onUpdate"
  />
</template>

<style scoped>
.date-input {
  width: 100%;
}
</style>
