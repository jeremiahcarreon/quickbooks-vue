<script setup lang="ts">
/**
 * Picks a list object for a `...Ref` field. Searches the read model
 * (GET /api/objects/<entity>?q=) across one or more entity types and emits
 * `{ ListID, FullName }`. Free text is kept as `{ FullName }` so QuickBooks
 * resolves it (allowFreeText).
 */
import AutoComplete from 'primevue/autocomplete';
import { computed, ref, watch } from 'vue';
import { objectsApi } from '@/api/endpoints';
import type { QbObject } from '@/api/types';
import { humanize } from '@/lib/labels';
import { useAuthStore } from '@/stores/auth';
import type { RefValue } from './types';

interface Suggestion {
  key: string;
  label: string;
  sub: string;
  entity: string;
  row: QbObject;
}

const props = withDefaults(
  defineProps<{
    modelValue?: RefValue | null;
    entity: string | string[];
    placeholder?: string;
    disabled?: boolean;
    invalid?: boolean;
    filter?: Record<string, string>;
    allowFreeText?: boolean;
    pageSize?: number;
    inputId?: string;
  }>(),
  {
    modelValue: null,
    placeholder: 'Search…',
    disabled: false,
    invalid: false,
    filter: undefined,
    allowFreeText: true,
    pageSize: 15,
    inputId: undefined,
  },
);
const emit = defineEmits<{
  'update:modelValue': [value: RefValue | null];
  select: [row: QbObject | null];
}>();

const auth = useAuthStore();
const targets = computed(() => {
  const list = Array.isArray(props.entity) ? props.entity : [props.entity];
  return list.filter((t) => auth.canRead(t));
});

const suggestions = ref<Suggestion[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const text = ref<string | Suggestion>(props.modelValue?.FullName ?? props.modelValue?.ListID ?? '');
let seq = 0;

watch(
  () => props.modelValue,
  (v) => {
    const t = typeof text.value === 'string' ? text.value : text.value.label;
    const want = v?.FullName ?? v?.ListID ?? '';
    if (t !== want) text.value = want;
  },
);

function labelOf(row: QbObject): string {
  const d = row.data;
  return String(d.FullName ?? row.name ?? d.Name ?? row.refNumber ?? row.id);
}

function subOf(row: QbObject, entity: string): string {
  const d = row.data;
  const bits: string[] = [];
  if (targets.value.length > 1) bits.push(humanize(entity));
  for (const k of ['CompanyName', 'Desc', 'SalesDesc', 'PurchaseDesc', 'AccountType', 'Email']) {
    if (typeof d[k] === 'string' && d[k]) {
      bits.push(String(d[k]).slice(0, 60));
      break;
    }
  }
  if (row.isActive === false) bits.push('inactive');
  return bits.join(' · ');
}

/** Search every target type in parallel and merge by name. */
async function search(query: string) {
  const my = ++seq;
  loading.value = true;
  error.value = null;
  try {
    const pages = await Promise.all(
      targets.value.map((t) =>
        objectsApi
          .list(t, {
            q: query || undefined,
            pageSize: props.pageSize,
            sort: 'name',
            filter: props.filter,
          })
          .then((p) => p.items.map((row) => ({ row, entity: t })))
          .catch(() => []),
      ),
    );
    if (my !== seq) return;
    suggestions.value = pages
      .flat()
      .map(({ row, entity }) => ({
        key: `${entity}:${row.id}`,
        label: labelOf(row),
        sub: subOf(row, entity),
        entity,
        row,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    if (my === seq) error.value = (err as Error).message;
  } finally {
    if (my === seq) loading.value = false;
  }
}

function onComplete(e: { query: string }) {
  void search(e.query.trim());
}

function onSelect(e: { value: Suggestion }) {
  const s = e.value;
  text.value = s.label;
  emit('update:modelValue', { ListID: s.row.id, FullName: s.label });
  emit('select', s.row);
}

function onBlur() {
  const t = typeof text.value === 'string' ? text.value.trim() : text.value.label;
  const cur = props.modelValue?.FullName ?? props.modelValue?.ListID ?? '';
  if (t === cur) return;
  if (t === '') {
    emit('update:modelValue', null);
    emit('select', null);
  } else if (props.allowFreeText) {
    const exact = suggestions.value.find((s) => s.label.toLowerCase() === t.toLowerCase());
    if (exact) {
      emit('update:modelValue', { ListID: exact.row.id, FullName: exact.label });
      emit('select', exact.row);
    } else {
      emit('update:modelValue', { FullName: t });
      emit('select', null);
    }
  } else {
    text.value = cur;
  }
}

function onClear() {
  emit('update:modelValue', null);
  emit('select', null);
}
</script>

<template>
  <AutoComplete
    v-model="text"
    :input-id="inputId"
    :suggestions="suggestions"
    option-label="label"
    :placeholder="placeholder"
    :disabled="disabled"
    :invalid="invalid"
    :loading="loading"
    dropdown
    dropdown-mode="current"
    :delay="250"
    :min-length="0"
    complete-on-focus
    class="ref-picker"
    input-class="ref-picker__input"
    @complete="onComplete"
    @option-select="onSelect"
    @blur="onBlur"
    @clear="onClear"
  >
    <template #option="{ option }">
      <div class="ref-picker__option">
        <span>{{ option.label }}</span>
        <small v-if="option.sub">{{ option.sub }}</small>
      </div>
    </template>
    <template #empty>
      <span class="ref-picker__empty">{{
        error ?? (targets.length ? 'No matches' : 'No access to this list')
      }}</span>
    </template>
  </AutoComplete>
</template>

<style scoped>
.ref-picker {
  width: 100%;
}
.ref-picker :deep(.ref-picker__input) {
  width: 100%;
}
.ref-picker__option {
  display: flex;
  flex-direction: column;
}
.ref-picker__option small {
  color: var(--p-text-muted-color);
}
.ref-picker__empty {
  color: var(--p-text-muted-color);
}
</style>
