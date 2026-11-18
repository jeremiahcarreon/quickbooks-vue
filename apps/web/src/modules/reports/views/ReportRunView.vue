<script setup lang="ts">
import Button from 'primevue/button';
import Message from 'primevue/message';
import ProgressSpinner from 'primevue/progressspinner';
import Tag from 'primevue/tag';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { runReport } from '../api';
import ReportParamsForm from '../components/ReportParamsForm.vue';
import ReportTable from '../components/ReportTable.vue';
import { downloadCsv } from '../format';
import { initialState, requestParams, toRouteQuery, type FormState } from '../form-state';
import { useReportCatalog } from '../store';
import type { ReportResult } from '../types';

const props = defineProps<{ name: string }>();
const route = useRoute();
const router = useRouter();
const catalog = useReportCatalog();

const state = ref<FormState>({ preset: '', values: {} });
const result = ref<ReportResult | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const pending = ref<string | null>(null);
let controller: AbortController | null = null;

const report = computed(() => catalog.find(props.name));
const isQb = computed(() => report.value?.source === 'qb');

async function run(refresh = false) {
  const info = report.value;
  if (!info) return;
  controller?.abort();
  const ctl = new AbortController();
  controller = ctl;
  busy.value = true;
  error.value = null;
  pending.value = null;
  const params = requestParams(info, state.value);
  void router.replace({ query: toRouteQuery(params) }).catch(() => undefined);
  try {
    result.value = await runReport(info.name, params, {
      refresh,
      signal: ctl.signal,
      onPending: ({ commandStatus }) => {
        pending.value =
          commandStatus === 'sending'
            ? 'QuickBooks is preparing the report…'
            : 'Waiting in the QuickBooks queue…';
      },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (controller === ctl) {
      busy.value = false;
      pending.value = null;
    }
  }
}

async function init() {
  await catalog.load();
  const info = report.value;
  result.value = null;
  error.value = null;
  if (!info) return;
  state.value = initialState(info, route.query as Record<string, unknown>);
  // Instant reports run straight away; QuickBooks reports wait for the user.
  if (info.source === 'sql') await run();
}

watch(
  () => props.name,
  () => void init(),
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());

function openRef(ref: { type: string; id: string }) {
  if (router.hasRoute('entity-detail')) {
    void router.push({ name: 'entity-detail', params: { type: ref.type, id: ref.id } });
  }
}

const stamp = computed(() => {
  const m = result.value?.meta;
  if (!m) return '';
  const when = new Date(m.fetchedAt ?? m.generatedAt).toLocaleString();
  return m.source === 'qb'
    ? `From QuickBooks ${when}${m.cached ? ' (cached)' : ''}`
    : `Generated ${when}`;
});

function print() {
  window.print();
}
</script>

<template>
  <section class="report-run">
    <nav class="report-run__crumbs no-print">
      <RouterLink :to="{ name: 'reports' }"><i class="pi pi-angle-left" /> Reports</RouterLink>
    </nav>

    <ProgressSpinner v-if="!catalog.loaded && catalog.loading" class="spinner" />
    <Message v-else-if="catalog.error" severity="error">{{ catalog.error }}</Message>
    <Message v-else-if="catalog.loaded && !report" severity="warn">
      Report "{{ name }}" does not exist or you do not have access to it.
    </Message>

    <template v-if="report">
      <header class="report-run__head no-print">
        <div>
          <h1>
            {{ report.title }}
            <Tag v-if="isQb" value="QuickBooks" severity="info" />
          </h1>
          <p class="muted">{{ report.description }}</p>
        </div>
        <div class="report-run__tools">
          <Button
            label="Export CSV"
            icon="pi pi-download"
            severity="secondary"
            outlined
            :disabled="!result"
            @click="result && downloadCsv(result)"
          />
          <Button
            label="Print"
            icon="pi pi-print"
            severity="secondary"
            outlined
            :disabled="!result"
            @click="print"
          />
        </div>
      </header>

      <div class="report-run__form no-print">
        <ReportParamsForm
          v-model="state"
          :report="report"
          :busy="busy"
          :is-qb="isQb"
          @run="run()"
          @refresh="run(true)"
        />
      </div>

      <Message v-if="error" severity="error" class="no-print">{{ error }}</Message>
      <div v-if="pending" class="report-run__pending no-print" role="status">
        <ProgressSpinner style="width: 1.5rem; height: 1.5rem" stroke-width="6" />
        <span>{{ pending }}</span>
      </div>

      <article v-if="result" class="report-print-area" :class="{ 'is-stale': busy }">
        <header class="report-run__title">
          <h2>{{ result.meta.title }}</h2>
          <p v-if="result.meta.subtitle">{{ result.meta.subtitle }}</p>
          <p v-if="result.meta.basis" class="muted">{{ result.meta.basis }} basis</p>
        </header>
        <ReportTable :result="result" @open="openRef" />
        <footer class="report-run__foot">
          <span>{{ stamp }}</span>
          <span v-for="(n, i) in result.meta.notes ?? []" :key="i" class="muted">{{ n }}</span>
        </footer>
      </article>
      <p v-else-if="!busy && isQb && !error" class="muted">
        Choose the settings and run the report. QuickBooks reports are produced by QuickBooks and
        may take a moment.
      </p>
    </template>
  </section>
</template>

<style scoped>
.report-run {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.report-run__crumbs a {
  color: var(--p-text-muted-color);
  text-decoration: none;
}
.report-run__head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}
.report-run__head h1 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.25rem;
}
.report-run__tools {
  display: flex;
  gap: 0.5rem;
}
.report-run__form,
.report-print-area {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  padding: 1rem;
}
.report-run__pending {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: var(--p-text-muted-color);
}
.is-stale {
  opacity: 0.55;
}
.report-run__title {
  text-align: center;
  margin-bottom: 1rem;
}
.report-run__title h2 {
  margin: 0;
}
.report-run__title p {
  margin: 0.15rem 0 0;
}
.report-run__foot {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 1rem;
  font-size: 0.8rem;
}
.muted {
  color: var(--p-text-muted-color);
  margin: 0;
}
.spinner {
  display: block;
  margin: 2rem auto;
}
</style>

<style>
/* Print only the report: hide the app shell and controls, keep the table. */
@media print {
  @page {
    margin: 12mm;
  }
  body * {
    visibility: hidden;
  }
  .report-print-area,
  .report-print-area * {
    visibility: visible;
  }
  .report-print-area {
    position: absolute;
    inset: 0 auto auto 0;
    width: 100%;
    border: none !important;
    padding: 0 !important;
    opacity: 1 !important;
    background: #fff !important;
    color: #000 !important;
  }
  .no-print {
    display: none !important;
  }
}
</style>
