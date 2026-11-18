<script setup lang="ts">
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import InputText from 'primevue/inputtext';
import MultiSelect from 'primevue/multiselect';
import Select from 'primevue/select';
import { computed, ref } from 'vue';
import { applyPreset, hasPeriod, PERIOD_PARAMS, type FormState } from '../form-state';
import { PRESETS } from '../presets';
import type { ParamDef, ReportInfo } from '../types';

const props = defineProps<{ report: ReportInfo; busy?: boolean; isQb?: boolean }>();
const state = defineModel<FormState>({ required: true });
const emit = defineEmits<{ run: []; refresh: [] }>();

const presetOptions = [
  ...PRESETS.map((p) => ({ label: p.label, value: p.id })),
  { label: 'Custom', value: 'custom' },
];

const periodVisible = computed(() => hasPeriod(props.report));
const fields = computed(() => props.report.params.filter((p) => !PERIOD_PARAMS.has(p.name)));
/** Date params of the period group (e.g. "As of") sit next to the run button. */
const primary = computed(() =>
  fields.value.filter((p) => p.group === 'period' && p.type === 'date'),
);
const extra = computed(() => fields.value.filter((p) => !primary.value.includes(p)));
const showMore = ref(false);

function setPreset(id: string) {
  state.value = applyPreset(state.value, id);
}

function setDate(name: 'from' | 'to', v: string) {
  state.value = {
    preset: 'custom',
    values: { ...state.value.values, [name]: v || undefined },
  };
}

function setValue(name: string, v: unknown) {
  state.value = { ...state.value, values: { ...state.value.values, [name]: v as never } };
}

function textValue(p: ParamDef): string {
  const v = state.value.values[p.name];
  return Array.isArray(v) ? v.join(', ') : v === undefined ? '' : String(v);
}

function setText(p: ParamDef, raw: string) {
  if (p.type === 'multiString') {
    const list = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setValue(p.name, list.length ? list : undefined);
  } else if (p.type === 'integer') {
    setValue(p.name, raw === '' ? undefined : Number(raw));
  } else {
    setValue(p.name, raw === '' ? undefined : raw);
  }
}

const inputId = (p: ParamDef | string) => `rp-${typeof p === 'string' ? p : p.name}`;
const enumOptions = (p: ParamDef) => [
  ...(p.required ? [] : [{ label: '(default)', value: undefined }]),
  ...(p.options ?? []).map((o) => ({ label: o, value: o })),
];
</script>

<template>
  <form class="report-form" @submit.prevent="emit('run')">
    <div class="report-form__row">
      <template v-if="periodVisible">
        <div class="report-form__field">
          <label :for="inputId('preset')">Dates</label>
          <Select
            :input-id="inputId('preset')"
            :model-value="state.preset"
            :options="presetOptions"
            option-label="label"
            option-value="value"
            class="report-form__preset"
            @update:model-value="setPreset"
          />
        </div>
        <div class="report-form__field">
          <label :for="inputId('from')">From</label>
          <InputText
            :id="inputId('from')"
            type="date"
            :model-value="(state.values.from as string | undefined) ?? ''"
            @update:model-value="(v) => setDate('from', v ?? '')"
          />
        </div>
        <div class="report-form__field">
          <label :for="inputId('to')">To</label>
          <InputText
            :id="inputId('to')"
            type="date"
            :model-value="(state.values.to as string | undefined) ?? ''"
            @update:model-value="(v) => setDate('to', v ?? '')"
          />
        </div>
      </template>
      <template v-for="p in primary" :key="p.name">
        <div class="report-form__field">
          <label :for="inputId(p)">{{ p.label }}</label>
          <InputText
            :id="inputId(p)"
            type="date"
            :model-value="textValue(p)"
            @update:model-value="(v) => setText(p, v ?? '')"
          />
        </div>
      </template>
      <div class="report-form__actions">
        <Button type="submit" label="Run report" icon="pi pi-play" :loading="busy" />
        <Button
          v-if="isQb"
          type="button"
          label="Refresh from QuickBooks"
          icon="pi pi-refresh"
          severity="secondary"
          outlined
          :disabled="busy"
          @click="emit('refresh')"
        />
        <Button
          v-if="extra.length"
          type="button"
          :label="showMore ? 'Fewer options' : 'More options'"
          :icon="showMore ? 'pi pi-chevron-up' : 'pi pi-sliders-h'"
          severity="secondary"
          text
          @click="showMore = !showMore"
        />
      </div>
    </div>

    <div v-if="showMore && extra.length" class="report-form__more">
      <div v-for="p in extra" :key="p.name" class="report-form__field">
        <template v-if="p.type === 'boolean'">
          <div class="report-form__check">
            <Checkbox
              :input-id="inputId(p)"
              binary
              :model-value="state.values[p.name] === true"
              @update:model-value="(v: boolean) => setValue(p.name, v)"
            />
            <label :for="inputId(p)">{{ p.label }}</label>
          </div>
        </template>
        <template v-else>
          <label :for="inputId(p)">{{ p.label }}</label>
          <Select
            v-if="p.type === 'enum'"
            :input-id="inputId(p)"
            :model-value="state.values[p.name]"
            :options="enumOptions(p)"
            option-label="label"
            option-value="value"
            filter
            show-clear
            @update:model-value="(v) => setValue(p.name, v)"
          />
          <MultiSelect
            v-else-if="p.type === 'multiEnum'"
            :input-id="inputId(p)"
            :model-value="(state.values[p.name] as string[] | undefined) ?? []"
            :options="p.options ?? []"
            filter
            display="chip"
            :max-selected-labels="4"
            @update:model-value="(v: string[]) => setValue(p.name, v.length ? v : undefined)"
          />
          <InputText
            v-else
            :id="inputId(p)"
            :type="p.type === 'date' ? 'date' : p.type === 'integer' ? 'number' : 'text'"
            :model-value="textValue(p)"
            :placeholder="p.type === 'multiString' ? 'Comma-separated' : p.help"
            @update:model-value="(v) => setText(p, v ?? '')"
          />
        </template>
      </div>
    </div>
  </form>
</template>

<style scoped>
.report-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.report-form__row,
.report-form__more {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
}
.report-form__more {
  padding-top: 0.75rem;
  border-top: 1px dashed var(--p-content-border-color);
}
.report-form__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 10rem;
}
.report-form__field label {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
.report-form__preset {
  min-width: 12rem;
}
.report-form__check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-bottom: 0.5rem;
}
.report-form__check label {
  font-size: inherit;
  color: inherit;
}
.report-form__actions {
  display: flex;
  gap: 0.5rem;
  margin-left: auto;
}
</style>
