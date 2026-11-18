<script setup lang="ts">
/**
 * Spreadsheet-style line grid.
 *
 * Keys: Tab / Shift+Tab move between cells; Enter or ArrowDown moves to the
 * same column on the next line (a new line is added at the end); ArrowUp
 * moves up; Ctrl+Insert inserts a line above; Ctrl+Delete deletes the line.
 * A blank line is always kept at the bottom.
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { MetaDefs } from '../lib/api';
import { applyPricingEdit, blankLine, isBlankLine, itemDefaults, lineAmount } from '../lib/calc';
import { fmtMoney, normAmount, normPrice } from '../lib/decimal';
import type { LineColumn, LineSection, RefValue, TxnLine } from '../lib/types';
import RefPicker from './RefPicker.vue';

const props = defineProps<{
  section: LineSection;
  /** Line object for lengths/enums from meta (the Add or Mod line). */
  lineObject: string;
  defs?: MetaDefs;
  readonly?: boolean;
  /** Line indexes with problems, to highlight. */
  invalidLines?: number[];
}>();

const lines = defineModel<TxnLine[]>('lines', { required: true });
const table = ref<HTMLTableElement | null>(null);

const columns = computed(() =>
  props.section.columns.map((c) => {
    const def = props.defs?.get(props.lineObject)?.fields.find((f) => f.name === c.name);
    return { ...c, maxLength: def?.maxLength ?? c.maxLength, options: def?.enum ?? c.options };
  }),
);

watch(
  () => lines.value,
  (ls) => {
    if (props.readonly) return;
    const last = ls[ls.length - 1];
    if (!last || !isBlankLine(props.section, last)) lines.value = [...ls, blankLine()];
  },
  { immediate: true, deep: true },
);

function update(index: number, patch: Partial<TxnLine>) {
  lines.value = lines.value.map((l, i) => (i === index ? { ...l, ...patch } : l));
}

function setValue(index: number, col: LineColumn, value: unknown) {
  const line = lines.value[index];
  if (!line) return;
  const values = { ...line.values, [col.name]: value };
  const p = props.section.pricing;
  if (p && (col.name === p.qty || col.name === p.rate || col.name === p.amount)) {
    const res = applyPricingEdit(p, values, col.name);
    update(index, { values: res.values, lastEdited: res.lastEdited ?? line.lastEdited });
    return;
  }
  update(index, { values });
}

function onPicked(index: number, col: LineColumn, item: RefValue) {
  if (col.name !== 'ItemRef' || !props.section.itemDefaults) return;
  const line = lines.value[index];
  if (!line) return;
  const d = itemDefaults(item, props.section.itemDefaults);
  const values: Record<string, unknown> = { ...line.values, ItemRef: item };
  if (d.desc !== undefined) values.Desc = d.desc;
  if (props.section.columns.some((c) => c.name === 'SalesTaxCodeRef') && d.taxCode) {
    values.SalesTaxCodeRef = d.taxCode;
  }
  const p = props.section.pricing;
  if (p && d.price !== undefined) {
    values[p.rate] = d.price;
    const res = applyPricingEdit(p, values, p.rate);
    update(index, { values: res.values, lastEdited: 'rate' });
  } else update(index, { values });
}

function normalise(index: number, col: LineColumn, raw: string) {
  if (!raw.trim()) return;
  const v = col.kind === 'amount' ? normAmount(raw) : normPrice(raw);
  if (v && v !== raw) setValue(index, col, v);
}

function displayAmount(line: TxnLine): string {
  return isBlankLine(props.section, line) ? '' : fmtMoney(lineAmount(props.section, line));
}

function asRef(v: unknown): RefValue | null {
  return v && typeof v === 'object' ? (v as RefValue) : null;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function cellId(row: number, col: number) {
  return `${props.section.key}-r${row}-c${col}`;
}

async function focusCell(row: number, col: number) {
  await nextTick();
  const el = table.value?.querySelector<HTMLElement>(
    `[data-cell="${cellId(row, col)}"] input, [data-cell="${cellId(row, col)}"] select`,
  );
  el?.focus();
  if (el instanceof HTMLInputElement) el.select();
}

function insertAt(index: number) {
  const next = [...lines.value];
  next.splice(index, 0, blankLine());
  lines.value = next;
}

function removeAt(index: number) {
  const next = lines.value.filter((_, i) => i !== index);
  lines.value = next.length ? next : [blankLine()];
}

/** Insert above / delete the line holding focus (used by the form's hotkeys). */
function focusedRow(): number | null {
  const el = document.activeElement?.closest('[data-row]');
  if (!el || !table.value?.contains(el)) return null;
  return Number(el.getAttribute('data-row'));
}

function insertAtFocus(): boolean {
  const r = focusedRow();
  if (r === null) return false;
  insertAt(r);
  void focusCell(r, 0);
  return true;
}

function deleteAtFocus(): boolean {
  const r = focusedRow();
  if (r === null) return false;
  removeAt(r);
  void focusCell(Math.min(r, lines.value.length - 1), 0);
  return true;
}

defineExpose({ insertAtFocus, deleteAtFocus, focusCell });

function onKeydown(e: KeyboardEvent, row: number, col: number, kind: LineColumn['kind']) {
  if (e.ctrlKey && e.key === 'Insert') {
    e.preventDefault();
    e.stopPropagation();
    insertAt(row);
    void focusCell(row, col);
    return;
  }
  if (e.ctrlKey && e.key === 'Delete') {
    e.preventDefault();
    e.stopPropagation();
    removeAt(row);
    void focusCell(Math.min(row, lines.value.length - 1), col);
    return;
  }
  // Pickers use the arrows and Enter for their own lists.
  if (kind === 'ref' || kind === 'enum') return;
  if (e.key === 'Enter' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (row + 1 >= lines.value.length) lines.value = [...lines.value, blankLine()];
    void focusCell(row + 1, col);
  } else if (e.key === 'ArrowUp' && row > 0) {
    e.preventDefault();
    void focusCell(row - 1, col);
  }
}
</script>

<template>
  <div class="grid-wrap">
    <table ref="table" class="lines" :aria-label="section.label">
      <thead>
        <tr>
          <th class="lines__n" scope="col">#</th>
          <th
            v-for="c in columns"
            :key="c.name"
            scope="col"
            :style="c.width ? { width: c.width } : undefined"
            :class="{ lines__num: ['amount', 'price', 'qty'].includes(c.kind) }"
          >
            {{ c.label }}
          </th>
          <th v-if="section.pricing" class="lines__num" scope="col">Line total</th>
          <th class="lines__act" scope="col"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(line, r) in lines"
          :key="line.key"
          :data-row="r"
          :class="{ lines__bad: invalidLines?.includes(r) }"
        >
          <td class="lines__n">{{ r + 1 }}</td>
          <td
            v-for="(c, ci) in columns"
            :key="c.name"
            :data-cell="cellId(r, ci)"
            @keydown="onKeydown($event, r, ci, c.kind)"
          >
            <RefPicker
              v-if="c.kind === 'ref' && c.ref"
              :model-value="asRef(line.values[c.name])"
              :source="c.ref"
              :aria-label="`Line ${r + 1} ${c.label}`"
              :disabled="readonly"
              placeholder=" "
              compact
              @update:model-value="setValue(r, c, $event)"
              @picked="onPicked(r, c, $event)"
            />
            <select
              v-else-if="c.kind === 'enum'"
              class="cell"
              :aria-label="`Line ${r + 1} ${c.label}`"
              :value="text(line.values[c.name])"
              :disabled="readonly"
              @change="setValue(r, c, ($event.target as HTMLSelectElement).value)"
            >
              <option value="" />
              <option v-for="o in c.options ?? []" :key="o" :value="o">{{ o }}</option>
            </select>
            <input
              v-else-if="c.kind === 'date'"
              type="date"
              class="cell"
              :aria-label="`Line ${r + 1} ${c.label}`"
              :value="text(line.values[c.name])"
              :disabled="readonly"
              @input="setValue(r, c, ($event.target as HTMLInputElement).value)"
            />
            <input
              v-else-if="c.kind === 'bool'"
              type="checkbox"
              :aria-label="`Line ${r + 1} ${c.label}`"
              :checked="line.values[c.name] === true"
              :disabled="readonly"
              @change="setValue(r, c, ($event.target as HTMLInputElement).checked)"
            />
            <input
              v-else
              class="cell"
              :class="{ 'cell--num': c.kind !== 'text' }"
              :aria-label="`Line ${r + 1} ${c.label}`"
              :inputmode="c.kind === 'text' ? undefined : 'decimal'"
              :maxlength="c.kind === 'text' ? c.maxLength : undefined"
              :value="text(line.values[c.name])"
              :readonly="readonly"
              autocomplete="off"
              @input="setValue(r, c, ($event.target as HTMLInputElement).value)"
              @blur="
                c.kind !== 'text' && normalise(r, c, ($event.target as HTMLInputElement).value)
              "
            />
          </td>
          <td v-if="section.pricing" class="lines__num lines__total">{{ displayAmount(line) }}</td>
          <td class="lines__act">
            <button
              v-if="!readonly && !isBlankLine(section, line)"
              type="button"
              class="lines__del"
              :aria-label="`Delete line ${r + 1}`"
              title="Delete line (Ctrl+Delete)"
              @click="removeAt(r)"
            >
              <i class="pi pi-times" aria-hidden="true" />
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.grid-wrap {
  overflow-x: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
}
.lines {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
  font-size: 0.925rem;
}
.lines th {
  text-align: left;
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--p-text-muted-color);
  background: var(--p-content-hover-background);
  padding: 0.35rem 0.4rem;
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}
.lines td {
  padding: 1px 2px;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: middle;
}
.lines tbody tr:nth-child(even) td {
  background: color-mix(in srgb, var(--p-content-hover-background) 40%, transparent);
}
.lines__bad td {
  background: color-mix(in srgb, var(--p-red-500) 10%, transparent) !important;
}
.lines__n {
  width: 2rem;
  text-align: right;
  color: var(--p-text-muted-color);
  padding-right: 0.4rem !important;
}
.lines__num {
  text-align: right !important;
}
.lines__total {
  font-variant-numeric: tabular-nums;
  padding-right: 0.5rem !important;
  white-space: nowrap;
}
.lines__act {
  width: 2rem;
}
.lines__del {
  border: 0;
  background: transparent;
  color: var(--p-text-muted-color);
  cursor: pointer;
  padding: 0.25rem;
}
.lines__del:hover {
  color: var(--p-red-500);
}
.cell {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  border: 1px solid transparent;
  background: transparent;
  color: var(--p-text-color);
  padding: 0.3rem 0.35rem;
  min-width: 4rem;
}
.cell:focus {
  outline: none;
  border-color: var(--p-primary-color);
  background: var(--p-content-background);
}
.cell--num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.lines :deep(.p-autocomplete-input) {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}
.lines :deep(.p-autocomplete-input:focus) {
  border-color: var(--p-primary-color);
}
.lines :deep(.p-autocomplete-dropdown) {
  background: transparent;
  border-color: transparent;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
