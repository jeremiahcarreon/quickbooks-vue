<script setup lang="ts">
import IconField from 'primevue/iconfield';
import InputIcon from 'primevue/inputicon';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import ProgressSpinner from 'primevue/progressspinner';
import SelectButton from 'primevue/selectbutton';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useReportCatalog } from '../store';
import type { ReportInfo } from '../types';

const catalog = useReportCatalog();
const search = ref('');
const source = ref<'all' | 'sql' | 'qb'>('all');
const sourceOptions = [
  { label: 'All', value: 'all' },
  { label: 'Instant', value: 'sql' },
  { label: 'From QuickBooks', value: 'qb' },
];

onMounted(() => void catalog.load());

const matches = (r: ReportInfo, words: string[]) => {
  const hay = `${r.title} ${r.description} ${r.category} ${r.name}`.toLowerCase();
  return words.every((w) => hay.includes(w));
};

const groups = computed(() => {
  const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  const list = catalog.reports.filter(
    (r) => (source.value === 'all' || r.source === source.value) && matches(r, words),
  );
  const byCat = new Map<string, ReportInfo[]>();
  for (const r of list) {
    const l = byCat.get(r.category) ?? [];
    l.push(r);
    byCat.set(r.category, l);
  }
  return [...byCat.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, reports]) => ({
      category,
      // Instant (read-model) reports first, then alphabetical.
      reports: reports.sort((a, b) =>
        a.source === b.source ? a.title.localeCompare(b.title) : a.source === 'sql' ? -1 : 1,
      ),
    }));
});
const total = computed(() => groups.value.reduce((n, g) => n + g.reports.length, 0));
</script>

<template>
  <section class="reports-catalog">
    <header class="reports-catalog__head">
      <div>
        <h1>Reports</h1>
        <p class="muted">
          Instant reports read the synchronized data. Reports marked
          <Tag value="QuickBooks" severity="info" /> are produced by QuickBooks itself and cached
          for a few minutes.
        </p>
      </div>
      <div class="reports-catalog__tools">
        <IconField>
          <InputIcon class="pi pi-search" />
          <InputText v-model="search" placeholder="Find a report" aria-label="Find a report" />
        </IconField>
        <SelectButton
          v-model="source"
          :options="sourceOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          aria-label="Report source"
        />
      </div>
    </header>

    <ProgressSpinner v-if="catalog.loading && !catalog.loaded" class="spinner" />
    <Message v-else-if="catalog.error" severity="error">{{ catalog.error }}</Message>
    <p v-else-if="catalog.loaded && total === 0" class="muted">No reports match.</p>

    <div class="reports-catalog__grid">
      <section v-for="g in groups" :key="g.category" class="reports-catalog__group">
        <h2>{{ g.category }}</h2>
        <ul>
          <li v-for="r in g.reports" :key="r.name">
            <RouterLink :to="{ name: 'report-run', params: { name: r.name } }" class="report-item">
              <span class="report-item__title">{{ r.title }}</span>
              <Tag
                v-if="r.source === 'qb'"
                value="QuickBooks"
                severity="info"
                class="report-item__tag"
              />
              <span class="report-item__desc">{{ r.description }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped>
.reports-catalog__head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-end;
  gap: 1rem;
  margin-bottom: 1rem;
}
.reports-catalog__head h1 {
  margin: 0 0 0.25rem;
}
.reports-catalog__tools {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.muted {
  color: var(--p-text-muted-color);
  margin: 0;
}
.spinner {
  display: block;
  margin: 2rem auto;
}
.reports-catalog__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(22rem, 1fr));
  gap: 1rem;
}
.reports-catalog__group {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  padding: 0.75rem 1rem;
}
.reports-catalog__group h2 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
.reports-catalog__group ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.report-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.1rem 0.5rem;
  padding: 0.4rem 0.5rem;
  border-radius: var(--p-content-border-radius);
  color: inherit;
  text-decoration: none;
}
.report-item:hover {
  background: var(--p-content-hover-background);
}
.report-item__title {
  font-weight: 500;
  color: var(--p-primary-color);
}
.report-item__tag {
  font-size: 0.7rem;
}
.report-item__desc {
  grid-column: 1 / -1;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
</style>
