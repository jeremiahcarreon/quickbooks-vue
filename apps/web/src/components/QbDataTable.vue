<script setup lang="ts">
/**
 * Server-side list of one entity from the read model (GET /api/objects/:type):
 * paging, sorting, full-text search, field filters and a column chooser over
 * every simple/ref field of the Ret. Refreshes on object.changed and shows
 * pending writes (badges, optimistic rows for adds).
 */
import Button from 'primevue/button';
import Chip from 'primevue/chip';
import Column from 'primevue/column';
import DataTable, { type DataTablePageEvent, type DataTableSortEvent } from 'primevue/datatable';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import MultiSelect from 'primevue/multiselect';
import Popover from 'primevue/popover';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiError } from '@/api/client';
import { objectsApi } from '@/api/endpoints';
import type { Page, QbObject } from '@/api/types';
import { formatBool, formatDate, formatMoney, textOf } from '@/lib/format';
import { humanize } from '@/lib/labels';
import { useCommandsStore } from '@/stores/commands';
import { useEventsStore } from '@/stores/events';
import { useMetaStore } from '@/stores/meta';
import PendingBadge from './PendingBadge.vue';
import { columnValue, defaultColumns, retColumns, sortKeyOf } from './tableColumns';
import type { ColumnSpec } from './types';

const props = withDefaults(
  defineProps<{
    entity: string;
    columns?: ColumnSpec[];
    filter?: Record<string, string>;
    q?: string;
    pageSize?: number;
    includeInactive?: boolean;
    columnChooser?: boolean;
    stateKey?: string;
    defaultSort?: string;
    /** Show the search box and filter controls. */
    toolbar?: boolean;
  }>(),
  {
    columns: undefined,
    filter: undefined,
    q: undefined,
    pageSize: 50,
    includeInactive: false,
    columnChooser: true,
    stateKey: undefined,
    defaultSort: undefined,
    toolbar: true,
  },
);
const emit = defineEmits<{
  'row-click': [row: QbObject];
  'update:q': [q: string];
  loaded: [page: Page<QbObject>];
}>();

const meta = useMetaStore();
const events = useEventsStore();
const commands = useCommandsStore();

const entityDef = computed(() => meta.entity(props.entity));
const available = computed<ColumnSpec[]>(() => {
  const base = defaultColumns(entityDef.value?.category ?? 'list');
  const extra = retColumns(
    entityDef.value ? meta.objects[entityDef.value.retElement] : undefined,
    meta.objects,
  );
  const all = [...(props.columns ?? []), ...base, ...extra];
  const seen = new Set<string>();
  return all.filter((c) => (seen.has(c.field) ? false : (seen.add(c.field), true)));
});

// ------------------------------------------------------------ persisted state

interface SavedState {
  columns?: string[];
  sort?: string;
  pageSize?: number;
}
const storageKey = computed(() => (props.stateKey ? `qbv.table.${props.stateKey}` : null));
function loadState(): SavedState {
  if (!storageKey.value) return {};
  try {
    return JSON.parse(globalThis.localStorage?.getItem(storageKey.value) ?? '{}') as SavedState;
  } catch {
    return {};
  }
}
const saved = loadState();
function saveState() {
  if (!storageKey.value) return;
  try {
    globalThis.localStorage?.setItem(
      storageKey.value,
      JSON.stringify({
        columns: chosen.value,
        sort: sortParam.value,
        pageSize: rows.value,
      } satisfies SavedState),
    );
  } catch {
    // ignore
  }
}

const chosen = ref<string[]>(saved.columns ?? []);
const visibleColumns = computed<ColumnSpec[]>(() => {
  if (chosen.value.length) {
    return chosen.value
      .map((f) => available.value.find((c) => c.field === f))
      .filter((c): c is ColumnSpec => !!c);
  }
  return props.columns ?? defaultColumns(entityDef.value?.category ?? 'list');
});
function onChooseColumns(fields: string[]) {
  chosen.value = fields;
  saveState();
}

// ------------------------------------------------------------ query state

const page = ref(1);
const rows = ref(saved.pageSize ?? props.pageSize);
const sortParam = ref<string | undefined>(saved.sort ?? props.defaultSort);
const search = ref(props.q ?? '');
const showInactive = ref(props.includeInactive);
interface UserFilter {
  field: string;
  op: string;
  value: string;
}
const userFilters = ref<UserFilter[]>([]);

watch(
  () => props.q,
  (v) => {
    if (v !== undefined && v !== search.value) {
      search.value = v;
      page.value = 1;
      void load();
    }
  },
);

const sortField = computed(() => {
  const s = sortParam.value?.split(',')[0];
  if (!s) return undefined;
  const f = s.replace(/^-/, '');
  return visibleColumns.value.find((c) => sortKeyOf(c) === f)?.field ?? f;
});
const sortOrder = computed(() => (sortParam.value?.startsWith('-') ? -1 : 1));

const items = ref<QbObject[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);
let controller: AbortController | null = null;

const allFilters = computed(() => {
  const out: Record<string, string> = { ...(props.filter ?? {}) };
  for (const f of userFilters.value) out[f.field] = `${f.op}:${f.value}`;
  return out;
});

async function load() {
  controller?.abort();
  const ctl = new AbortController();
  controller = ctl;
  loading.value = true;
  error.value = null;
  try {
    const res = await objectsApi.list(
      props.entity,
      {
        q: search.value || undefined,
        sort: sortParam.value,
        page: page.value,
        pageSize: rows.value,
        includeInactive: showInactive.value,
        filter: Object.keys(allFilters.value).length ? allFilters.value : undefined,
      },
      ctl.signal,
    );
    if (controller !== ctl) return;
    items.value = res.items;
    total.value = res.total;
    emit('loaded', res);
  } catch (err) {
    if ((err as Error).name === 'AbortError' || controller !== ctl) return;
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    if (controller === ctl) loading.value = false;
  }
}

function onPage(e: DataTablePageEvent) {
  page.value = e.page + 1;
  if (e.rows !== rows.value) {
    rows.value = e.rows;
    saveState();
  }
  void load();
}
function onSort(e: DataTableSortEvent) {
  const col = visibleColumns.value.find((c) => c.field === e.sortField);
  const key = col ? sortKeyOf(col) : String(e.sortField ?? '');
  sortParam.value = key ? `${e.sortOrder === -1 ? '-' : ''}${key}` : undefined;
  page.value = 1;
  saveState();
  void load();
}
let searchTimer: ReturnType<typeof setTimeout> | null = null;
function onSearch(v: string | undefined) {
  search.value = v ?? '';
  emit('update:q', search.value);
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page.value = 1;
    void load();
  }, 300);
}
function onInactive(v: boolean) {
  showInactive.value = v;
  page.value = 1;
  void load();
}

// ------------------------------------------------------------ filters UI

const filterPop = ref<InstanceType<typeof Popover> | null>(null);
const draft = ref<UserFilter>({ field: '', op: 'eq', value: '' });
const OPS = [
  { label: 'equals', value: 'eq' },
  { label: 'not equal', value: 'ne' },
  { label: 'contains', value: 'like' },
  { label: '>', value: 'gt' },
  { label: '≥', value: 'gte' },
  { label: '<', value: 'lt' },
  { label: '≤', value: 'lte' },
  { label: 'is empty', value: 'isnull' },
  { label: 'is not empty', value: 'notnull' },
];
const filterFields = computed(() =>
  available.value.map((c) => ({ label: c.header ?? humanize(c.field), value: sortKeyOf(c) })),
);
function addFilter() {
  const d = draft.value;
  if (!d.field) return;
  const value = d.op === 'like' && d.value && !d.value.includes('%') ? `%${d.value}%` : d.value;
  userFilters.value = [...userFilters.value.filter((f) => f.field !== d.field), { ...d, value }];
  draft.value = { field: '', op: 'eq', value: '' };
  filterPop.value?.hide();
  page.value = 1;
  void load();
}
function removeFilter(i: number) {
  userFilters.value = userFilters.value.filter((_, j) => j !== i);
  page.value = 1;
  void load();
}
const labelOfField = (f: string) =>
  filterFields.value.find((x) => x.value === f)?.label ?? humanize(f);
const opLabel = (op: string) => OPS.find((o) => o.value === op)?.label ?? op;

// ------------------------------------------------------------ pending / live

const optimistic = computed<QbObject[]>(() =>
  page.value === 1
    ? commands.pendingAdds(props.entity).map((c) => ({
        type: props.entity,
        id: `pending:${c.id}`,
        editSequence: null,
        name: String(c.submitted?.FullName ?? c.submitted?.Name ?? ''),
        refNumber: (c.submitted?.RefNumber as string | undefined) ?? null,
        txnDate: (c.submitted?.TxnDate as string | undefined) ?? null,
        amount: null,
        isActive: true,
        timeCreated: null,
        timeModified: null,
        deletedAt: null,
        data: { ...(c.submitted ?? {}), __pending: c.id },
      }))
    : [],
);
const displayed = computed(() => [...optimistic.value, ...items.value]);

let reloadTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => events.revisions[props.entity],
  () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void load(), 400);
  },
);
watch(
  () => [props.entity, JSON.stringify(props.filter ?? {})],
  () => {
    page.value = 1;
    userFilters.value = [];
    void load();
  },
);

onMounted(() => {
  void meta.loadEntity(props.entity).catch(() => undefined);
  void load();
});
onBeforeUnmount(() => {
  controller?.abort();
  if (reloadTimer) clearTimeout(reloadTimer);
  if (searchTimer) clearTimeout(searchTimer);
});

function cell(row: QbObject, c: ColumnSpec): string {
  const v = columnValue(row, c);
  switch (c.kind) {
    case 'money':
      return formatMoney(textOf(v));
    case 'date':
      return formatDate(textOf(v));
    case 'bool':
      return formatBool(textOf(v));
    default:
      return textOf(v);
  }
}
function onRowClick(e: { data: QbObject }) {
  if (e.data.id.startsWith('pending:')) return;
  emit('row-click', e.data);
}
const isPendingRow = (row: QbObject) => row.id.startsWith('pending:');

defineExpose({ reload: load });
</script>

<template>
  <div class="qb-table">
    <div v-if="toolbar" class="qb-table__toolbar">
      <span class="p-input-icon-left qb-table__search">
        <InputText
          :model-value="search"
          placeholder="Search"
          aria-label="Search"
          type="search"
          @update:model-value="onSearch"
        />
      </span>
      <Button
        label="Filter"
        icon="pi pi-filter"
        size="small"
        text
        @click="(e) => filterPop?.toggle(e)"
      />
      <Chip
        v-for="(f, i) in userFilters"
        :key="f.field"
        :label="`${labelOfField(f.field)} ${opLabel(f.op)} ${f.value}`"
        removable
        @remove="removeFilter(i)"
      />
      <div class="qb-table__spacer" />
      <label v-if="entityDef?.category !== 'txn'" class="qb-table__inactive">
        <ToggleSwitch :model-value="showInactive" @update:model-value="onInactive" />
        <span>Show inactive</span>
      </label>
      <MultiSelect
        v-if="columnChooser"
        :model-value="visibleColumns.map((c) => c.field)"
        :options="available"
        option-label="header"
        option-value="field"
        filter
        :max-selected-labels="0"
        selected-items-label="Columns"
        placeholder="Columns"
        class="qb-table__columns"
        aria-label="Choose columns"
        @update:model-value="onChooseColumns"
      />
      <Button
        icon="pi pi-refresh"
        text
        rounded
        size="small"
        aria-label="Refresh"
        :loading="loading"
        @click="load"
      />
      <slot name="toolbar" />
    </div>

    <Popover ref="filterPop">
      <div class="qb-table__filter">
        <Select
          v-model="draft.field"
          :options="filterFields"
          option-label="label"
          option-value="value"
          filter
          placeholder="Field"
        />
        <Select v-model="draft.op" :options="OPS" option-label="label" option-value="value" />
        <InputText
          v-if="draft.op !== 'isnull' && draft.op !== 'notnull'"
          v-model="draft.value"
          placeholder="Value"
          @keydown.enter="addFilter"
        />
        <Button label="Apply" size="small" :disabled="!draft.field" @click="addFilter" />
      </div>
    </Popover>

    <Message v-if="error" severity="error" :closable="false" class="qb-table__error">{{
      error
    }}</Message>

    <DataTable
      :value="displayed"
      lazy
      paginator
      :rows="rows"
      :first="(page - 1) * rows"
      :total-records="total + optimistic.length"
      :rows-per-page-options="[25, 50, 100, 250]"
      :loading="loading"
      :sort-field="sortField"
      :sort-order="sortOrder"
      data-key="id"
      size="small"
      striped-rows
      row-hover
      scrollable
      class="qb-table__table"
      :row-class="(r: QbObject) => (isPendingRow(r) ? 'qb-table__row--pending' : 'qb-table__row')"
      @page="onPage"
      @sort="onSort"
      @row-click="onRowClick"
    >
      <template #empty>
        <span class="qb-table__empty">{{ loading ? 'Loading…' : 'Nothing found' }}</span>
      </template>
      <Column
        v-for="c in visibleColumns"
        :key="c.field"
        :field="c.field"
        :header="c.header ?? humanize(c.field)"
        :sortable="c.sortable !== false"
        :class="{ 'qb-table__num': c.kind === 'money' }"
      >
        <template #body="{ data }">
          <slot :name="`cell-${c.field}`" :row="data" :value="columnValue(data, c)">{{
            cell(data, c)
          }}</slot>
        </template>
      </Column>
      <Column header="" class="qb-table__status">
        <template #body="{ data }">
          <PendingBadge v-if="isPendingRow(data)" :status="'queued'" />
          <PendingBadge v-else :id="data.id" :entity="entity" />
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
.qb-table__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.5rem;
}
.qb-table__spacer {
  flex: 1;
}
.qb-table__inactive {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
}
.qb-table__columns {
  min-width: 9rem;
}
.qb-table__filter {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 16rem;
}
.qb-table__error {
  margin-bottom: 0.5rem;
}
.qb-table__table :deep(.qb-table__row) {
  cursor: pointer;
}
.qb-table__table :deep(.qb-table__row--pending) {
  opacity: 0.65;
  font-style: italic;
}
.qb-table__table :deep(.qb-table__num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.qb-table__table :deep(.qb-table__status) {
  width: 1%;
  white-space: nowrap;
}
.qb-table__empty {
  color: var(--p-text-muted-color);
}
</style>
