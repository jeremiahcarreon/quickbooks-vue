<script setup lang="ts">
/**
 * Editor for a repeating complex field (invoice lines, expense lines, applied
 * transactions...). Chosen columns are edited inline; every other field of the
 * line ObjectDef opens in a row expander.
 */
import Button from 'primevue/button';
import { computed, ref } from 'vue';
import {
  describeObject,
  newLine,
  type ErrorMap,
  type FormField,
  type FormValue,
} from '@/forms/model';
import { useMetaStore } from '@/stores/meta';
import FieldInput from './FieldInput.vue';
import ObjectForm from './ObjectForm.vue';

const props = withDefaults(
  defineProps<{
    modelValue: FormValue[];
    object: string;
    columns?: string[];
    errors?: ErrorMap;
    /** Path of the lines field (`InvoiceLineAdd`); rows are `<path>[i].` */
    path?: string;
    owner?: string;
    disabled?: boolean;
    minRows?: number;
    maxRows?: number;
  }>(),
  {
    columns: undefined,
    errors: () => ({}),
    path: '',
    owner: undefined,
    disabled: false,
    minRows: 0,
    maxRows: undefined,
  },
);
const emit = defineEmits<{
  'update:modelValue': [value: FormValue[]];
  'line-change': [e: { index: number; field: string; value: unknown; line: FormValue }];
}>();

const meta = useMetaStore();
const form = computed(() => {
  try {
    return describeObject(props.object, meta.ctx(props.owner));
  } catch {
    return null;
  }
});

const PREFERRED = [
  'ItemRef',
  'AccountRef',
  'ItemGroupRef',
  'Desc',
  'Memo',
  'Quantity',
  'Rate',
  'Amount',
  'TxnID',
  'PaymentAmount',
  'ClassRef',
];
const INLINE = new Set([
  'text',
  'enum',
  'number',
  'money',
  'date',
  'bool',
  'ref',
  'id',
  'textarea',
]);

const cols = computed<FormField[]>(() => {
  const f = form.value;
  if (!f) return [];
  const visible = f.fields.filter((x) => !x.hidden && INLINE.has(x.kind));
  if (props.columns?.length) {
    return props.columns
      .map((n) => visible.find((x) => x.name === n))
      .filter((x): x is FormField => !!x);
  }
  const picked: FormField[] = [];
  for (const n of PREFERRED) {
    const x = visible.find((v) => v.name === n);
    if (x && picked.length < 6) picked.push(x);
  }
  for (const x of visible) {
    if (picked.length >= 4) break;
    if (!picked.includes(x)) picked.push(x);
  }
  return f.fields.filter((x) => picked.includes(x));
});
const colNames = computed(() => cols.value.map((c) => c.name));
const hasMore = computed(
  () =>
    !!form.value && form.value.fields.some((x) => !x.hidden && !colNames.value.includes(x.name)),
);

const expanded = ref(new Set<number>());
const rows = computed(() => props.modelValue ?? []);
const canAdd = computed(
  () => !props.disabled && (props.maxRows === undefined || rows.value.length < props.maxRows),
);

function emitRows(next: FormValue[]) {
  emit('update:modelValue', next);
}
function setCell(i: number, field: string, value: unknown) {
  const line = { ...rows.value[i], [field]: value };
  const next = rows.value.slice();
  next[i] = line;
  emitRows(next);
  emit('line-change', { index: i, field, value, line });
}
function setRow(i: number, line: FormValue) {
  const next = rows.value.slice();
  const before = rows.value[i] ?? {};
  next[i] = line;
  emitRows(next);
  for (const k of Object.keys(line)) {
    if (line[k] !== before[k]) emit('line-change', { index: i, field: k, value: line[k], line });
  }
}
function add() {
  emitRows([...rows.value, newLine(props.object, meta.ctx(props.owner))]);
}
function remove(i: number) {
  const next = rows.value.slice();
  next.splice(i, 1);
  expanded.value = new Set(
    [...expanded.value].filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)),
  );
  emitRows(next);
}
function move(i: number, d: -1 | 1) {
  const j = i + d;
  if (j < 0 || j >= rows.value.length) return;
  const next = rows.value.slice();
  [next[i], next[j]] = [next[j]!, next[i]!];
  emitRows(next);
}
function toggle(i: number) {
  const s = new Set(expanded.value);
  if (s.has(i)) s.delete(i);
  else s.add(i);
  expanded.value = s;
}
function rowHasHiddenError(i: number): boolean {
  const prefix = `${props.path}[${i}].`;
  return Object.keys(props.errors).some(
    (k) => k.startsWith(prefix) && !colNames.value.includes(k.slice(prefix.length)),
  );
}
const cellId = (i: number, f: string) => `li-${props.path}-${i}-${f}`.replace(/[^\w-]/g, '_');
</script>

<template>
  <div class="line-items" :data-object="object">
    <div class="line-items__scroll">
      <table class="line-items__table">
        <thead>
          <tr>
            <th class="line-items__num">#</th>
            <th
              v-for="c in cols"
              :key="c.name"
              :class="{ 'line-items__num-col': c.kind === 'money' || c.kind === 'number' }"
            >
              {{ c.label }}<span v-if="c.required" class="gf-req">*</span>
            </th>
            <th class="line-items__actions"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="(line, i) in rows" :key="i">
            <tr :class="{ 'line-items__row--error': rowHasHiddenError(i) }">
              <td class="line-items__num">{{ i + 1 }}</td>
              <td v-for="c in cols" :key="c.name">
                <slot
                  :name="`cell-${c.name}`"
                  :line="line"
                  :index="i"
                  :set="(v: unknown) => setCell(i, c.name, v)"
                >
                  <FieldInput
                    :field="c"
                    :model-value="line[c.name]"
                    :path="`${path}[${i}].${c.name}`"
                    :errors="errors"
                    :owner="owner"
                    :disabled="disabled"
                    :input-id="cellId(i, c.name)"
                    :aria-label="c.label"
                    compact
                    @update:model-value="(v) => setCell(i, c.name, v)"
                  />
                </slot>
                <small v-if="errors[`${path}[${i}].${c.name}`]" class="gf-error">{{
                  errors[`${path}[${i}].${c.name}`]
                }}</small>
              </td>
              <td class="line-items__actions">
                <Button
                  v-if="hasMore"
                  :icon="expanded.has(i) ? 'pi pi-chevron-up' : 'pi pi-ellipsis-h'"
                  text
                  rounded
                  size="small"
                  :severity="rowHasHiddenError(i) ? 'danger' : 'secondary'"
                  :aria-label="expanded.has(i) ? 'Hide details' : 'More fields'"
                  @click="toggle(i)"
                />
                <Button
                  icon="pi pi-arrow-up"
                  text
                  rounded
                  size="small"
                  severity="secondary"
                  aria-label="Move up"
                  :disabled="disabled || i === 0"
                  @click="move(i, -1)"
                />
                <Button
                  icon="pi pi-trash"
                  text
                  rounded
                  size="small"
                  severity="danger"
                  aria-label="Remove line"
                  :disabled="disabled || rows.length <= minRows"
                  @click="remove(i)"
                />
              </td>
            </tr>
            <tr v-if="expanded.has(i)" class="line-items__detail">
              <td :colspan="cols.length + 2">
                <ObjectForm
                  :model-value="line"
                  :object="object"
                  :owner="owner"
                  :errors="errors"
                  :path="`${path}[${i}].`"
                  :disabled="disabled"
                  :exclude="colNames"
                  nested
                  @update:model-value="(v) => setRow(i, v)"
                />
              </td>
            </tr>
          </template>
          <tr v-if="!rows.length">
            <td :colspan="cols.length + 2" class="line-items__empty">No lines</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="line-items__footer">
      <Button
        label="Add line"
        icon="pi pi-plus"
        size="small"
        text
        :disabled="!canAdd"
        @click="add"
      />
      <slot name="footer" :rows="rows" />
    </div>
  </div>
</template>

<style scoped>
.line-items__scroll {
  overflow-x: auto;
}
.line-items__table {
  width: 100%;
  border-collapse: collapse;
}
.line-items__table th {
  text-align: left;
  font-weight: 600;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  padding: 0.35rem 0.4rem;
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}
.line-items__table td {
  padding: 0.25rem 0.4rem;
  vertical-align: top;
  border-bottom: 1px solid var(--p-content-border-color);
  min-width: 8rem;
}
.line-items__table td.line-items__num,
.line-items__table td.line-items__actions {
  min-width: 0;
  white-space: nowrap;
}
.line-items__num {
  width: 2rem;
  color: var(--p-text-muted-color);
  padding-top: 0.7rem !important;
}
.line-items__num-col {
  text-align: right !important;
}
.line-items__actions {
  width: 1%;
}
.line-items__row--error td {
  background: color-mix(in srgb, var(--p-red-500) 6%, transparent);
}
.line-items__detail td {
  background: var(--p-content-hover-background);
}
.line-items__empty {
  color: var(--p-text-muted-color);
  text-align: center;
  padding: 0.75rem !important;
}
.line-items__footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 0.25rem;
}
</style>
