<script setup lang="ts">
import { computed } from 'vue';
import { formatCell, isNumericColumn } from '../format';
import type { ReportColumn, ReportResult, ReportRow } from '../types';

const props = defineProps<{ result: ReportResult }>();
const emit = defineEmits<{ open: [ref: { type: string; id: string }] }>();

const columns = computed(() => props.result.columns);
const titleRows = computed(() => Math.max(1, ...columns.value.map((c) => c.titles?.length ?? 1)));

function titleAt(c: ReportColumn, row: number): string {
  if (titleRows.value === 1) return c.title;
  return c.titles?.[row] ?? (row === titleRows.value - 1 ? c.title : '');
}

function cellText(row: ReportRow, c: ReportColumn, index: number): string {
  const v = row.cells[c.key];
  if (index === 0 && (v === undefined || v === null || v === '') && row.kind !== 'data') {
    return row.label ?? '';
  }
  return formatCell(v, c.type);
}

function isNegative(row: ReportRow, c: ReportColumn): boolean {
  const v = row.cells[c.key];
  return typeof v === 'number' && v < 0;
}

const indentStyle = (row: ReportRow) => ({ paddingLeft: `${0.5 + row.indent * 1.25}rem` });
</script>

<template>
  <div class="report-table-wrap">
    <table class="report-table" :aria-label="result.meta.title">
      <thead>
        <tr v-for="r in titleRows" :key="r">
          <th
            v-for="c in columns"
            :key="c.key"
            scope="col"
            :class="{ 'is-num': isNumericColumn(c.type) }"
          >
            {{ titleAt(c, r - 1) }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in result.rows" :key="i" :class="`row--${row.kind}`">
          <template v-if="row.kind === 'text'">
            <th scope="rowgroup" :colspan="columns.length" :style="indentStyle(row)">
              {{ row.label }}
            </th>
          </template>
          <template v-else>
            <td
              v-for="(c, ci) in columns"
              :key="c.key"
              :class="{ 'is-num': isNumericColumn(c.type), 'is-neg': isNegative(row, c) }"
              :style="ci === 0 ? indentStyle(row) : undefined"
            >
              <a
                v-if="ci === 0 && row.ref && cellText(row, c, ci)"
                href="#"
                class="report-link"
                @click.prevent="emit('open', row.ref)"
                >{{ cellText(row, c, ci) }}</a
              >
              <template v-else>{{ cellText(row, c, ci) }}</template>
            </td>
          </template>
        </tr>
        <tr v-if="result.rows.length === 0" class="row--empty">
          <td :colspan="Math.max(1, columns.length)">No data for these settings.</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.report-table-wrap {
  overflow-x: auto;
}
.report-table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
  font-size: 0.95rem;
}
.report-table th,
.report-table td {
  padding: 0.3rem 0.5rem;
  text-align: left;
  white-space: nowrap;
  vertical-align: top;
}
.report-table thead th {
  position: sticky;
  top: 0;
  background: var(--p-content-background);
  border-bottom: 2px solid var(--p-content-border-color);
  font-weight: 600;
}
.report-table .is-num {
  text-align: right;
}
.report-table .is-neg {
  color: var(--p-red-600, #c62828);
}
.row--data:hover td {
  background: var(--p-content-hover-background);
}
.row--text th {
  font-weight: 600;
  padding-top: 0.6rem;
}
.row--subtotal td {
  font-weight: 600;
  border-top: 1px solid var(--p-content-border-color);
}
.row--subtotal td.is-num {
  border-bottom: 1px solid var(--p-content-border-color);
}
.row--total td {
  font-weight: 700;
  border-top: 2px solid var(--p-text-color);
  border-bottom: 3px double var(--p-text-color);
}
.row--empty td {
  padding: 1.5rem;
  text-align: center;
  color: var(--p-text-muted-color);
}
.report-link {
  color: inherit;
  text-decoration: none;
}
.report-link:hover {
  text-decoration: underline;
  color: var(--p-primary-color);
}
@media print {
  .report-table {
    font-size: 9pt;
  }
  .report-table thead {
    display: table-header-group;
  }
  .report-table thead th {
    position: static;
  }
  .report-table tr {
    break-inside: avoid;
  }
  .report-table .is-neg {
    color: inherit;
  }
  .report-link {
    color: inherit;
    text-decoration: none;
  }
}
</style>
