<script setup lang="ts">
/**
 * Read-only view of a parsed Ret: every field, nested objects as sections,
 * repeating elements (lines) as tables, refs as links. Uses the Ret ObjectDef
 * for order and types when available; anything else is shown generically.
 */
import { computed } from 'vue';
import type { FieldDef } from '@/api/types';
import { isRefObject } from '@/forms/model';
import { formatBool, formatDate, formatMoney, textOf } from '@/lib/format';
import { humanize } from '@/lib/labels';
import { useMetaStore } from '@/stores/meta';
import RefLink from './RefLink.vue';

const props = withDefaults(
  defineProps<{ data: Record<string, unknown>; object?: string; owner?: string; depth?: number }>(),
  { object: undefined, owner: undefined, depth: 0 },
);

const meta = useMetaStore();
const def = computed(() => (props.object ? meta.objects[props.object] : undefined));

type Kind = 'simple' | 'ref' | 'object' | 'table';
interface Entry {
  name: string;
  label: string;
  kind: Kind;
  value: unknown;
  field?: FieldDef;
  child?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const looksLikeRef = (v: unknown) =>
  isObj(v) &&
  Object.keys(v).length > 0 &&
  Object.keys(v).every((k) => k === 'ListID' || k === 'FullName');

function kindOf(v: unknown, f?: FieldDef): Kind {
  if (f?.kind === 'complex') {
    const child = meta.objects[f.children ?? f.type];
    if (Array.isArray(v) || f.maxOccurs !== 1) return 'table';
    return isRefObject(child) || looksLikeRef(v) ? 'ref' : 'object';
  }
  if (Array.isArray(v)) return v.some(isObj) ? 'table' : 'simple';
  if (looksLikeRef(v)) return 'ref';
  if (isObj(v) && !('#text' in v)) return 'object';
  return 'simple';
}

const entries = computed<Entry[]>(() => {
  const data = props.data ?? {};
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (const f of def.value?.fields ?? []) {
    if (!(f.name in data)) continue;
    seen.add(f.name);
    const v = data[f.name];
    out.push({
      name: f.name,
      label: humanize(f.name.replace(/Ret$/, '')),
      kind: kindOf(v, f),
      value: v,
      field: f,
      child: f.children,
    });
  }
  for (const [k, v] of Object.entries(data)) {
    if (seen.has(k) || k.startsWith('@') || k.startsWith('__')) continue;
    out.push({ name: k, label: humanize(k.replace(/Ret$/, '')), kind: kindOf(v), value: v });
  }
  return out;
});

const simple = computed(() => entries.value.filter((e) => e.kind === 'simple' || e.kind === 'ref'));
const sections = computed(() =>
  entries.value.filter((e) => e.kind === 'object' || e.kind === 'table'),
);

function display(e: { value: unknown; field?: FieldDef }): string {
  const v = e.value;
  if (Array.isArray(v)) return v.map((x) => textOf(x)).join(', ');
  const s = textOf(v);
  switch (e.field?.type) {
    case 'AMTTYPE':
      return formatMoney(s);
    case 'PRICETYPE':
    case 'QUANTYPE':
    case 'PERCENTTYPE':
      return formatMoney(s, 0);
    case 'DATETYPE':
    case 'DATETIMETYPE':
      return formatDate(s);
    case 'BOOLTYPE':
      return formatBool(s);
  }
  if (!e.field && (s === 'true' || s === 'false')) return formatBool(s);
  return s;
}

/** Columns of a lines table: every key present in any row, in ObjectDef order when known. */
function tableColumns(e: Entry): { name: string; field?: FieldDef }[] {
  const rows = (Array.isArray(e.value) ? e.value : [e.value]).filter(isObj);
  const present = new Set(rows.flatMap((r) => Object.keys(r)).filter((k) => !k.startsWith('@')));
  const child = e.child ? meta.objects[e.child] : undefined;
  const cols: { name: string; field?: FieldDef }[] = [];
  for (const f of child?.fields ?? [])
    if (present.has(f.name)) cols.push({ name: f.name, field: f });
  for (const k of present) if (!cols.some((c) => c.name === k)) cols.push({ name: k });
  return cols;
}
function rowsOf(e: Entry): Record<string, unknown>[] {
  return (Array.isArray(e.value) ? e.value : [e.value]).filter(isObj);
}
function cellIsRef(v: unknown) {
  return looksLikeRef(v);
}
function cellText(v: unknown, field?: FieldDef): string {
  if (isObj(v) && !('#text' in v) && !looksLikeRef(v)) {
    return Object.entries(v)
      .filter(([k]) => !k.startsWith('@'))
      .map(([k, x]) => `${humanize(k)}: ${isObj(x) || Array.isArray(x) ? '…' : textOf(x)}`)
      .join('; ');
  }
  return display({ value: v, field });
}
function isNumeric(field?: FieldDef) {
  return !!field && ['AMTTYPE', 'PRICETYPE', 'QUANTYPE', 'PERCENTTYPE'].includes(field.type);
}
</script>

<template>
  <div class="object-view" :class="{ 'object-view--nested': depth > 0 }">
    <dl v-if="simple.length" class="object-view__grid">
      <div v-for="e in simple" :key="e.name" class="object-view__item" :data-field="e.name">
        <dt>{{ e.label }}</dt>
        <dd>
          <RefLink v-if="e.kind === 'ref'" :field="e.name" :value="e.value" :owner="owner" />
          <template v-else>{{ display(e) || '—' }}</template>
        </dd>
      </div>
    </dl>
    <section v-for="e in sections" :key="e.name" class="object-view__section" :data-field="e.name">
      <h3>{{ e.label }}</h3>
      <ObjectView
        v-if="e.kind === 'object'"
        :data="e.value as Record<string, unknown>"
        :object="e.child"
        :owner="owner"
        :depth="depth + 1"
      />
      <div v-else class="object-view__table-wrap">
        <table class="object-view__table">
          <thead>
            <tr>
              <th v-for="c in tableColumns(e)" :key="c.name" :class="{ num: isNumeric(c.field) }">
                {{ humanize(c.name.replace(/Ret$/, '')) }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in rowsOf(e)" :key="i">
              <td v-for="c in tableColumns(e)" :key="c.name" :class="{ num: isNumeric(c.field) }">
                <RefLink
                  v-if="cellIsRef(row[c.name])"
                  :field="c.name"
                  :value="row[c.name]"
                  :owner="owner"
                />
                <template v-else>{{ cellText(row[c.name], c.field) }}</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.object-view__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  gap: 0.75rem 1.5rem;
  margin: 0;
}
.object-view__item dt {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  margin-bottom: 0.15rem;
}
.object-view__item dd {
  margin: 0;
  word-break: break-word;
  white-space: pre-line;
}
.object-view__section {
  margin-top: 1.25rem;
}
.object-view__section h3 {
  font-size: 0.95rem;
  margin: 0 0 0.5rem;
}
.object-view--nested .object-view__section h3 {
  font-size: 0.85rem;
}
.object-view__table-wrap {
  overflow-x: auto;
}
.object-view__table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.9rem;
}
.object-view__table th,
.object-view__table td {
  text-align: left;
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: top;
}
.object-view__table th {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}
.num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
</style>
