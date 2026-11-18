import { defineStore } from 'pinia';
import { ref } from 'vue';
import { listReports } from './api';
import type { ReportInfo } from './types';

/** The report catalog the current user may run, loaded once per session. */
export const useReportCatalog = defineStore('reports.catalog', () => {
  const reports = ref<ReportInfo[]>([]);
  const categories = ref<string[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let inflight: Promise<void> | null = null;

  function load(force = false): Promise<void> {
    if (loaded.value && !force) return Promise.resolve();
    if (inflight) return inflight;
    loading.value = true;
    error.value = null;
    inflight = listReports()
      .then((r) => {
        reports.value = r.reports;
        categories.value = r.categories;
        loaded.value = true;
      })
      .catch((e: unknown) => {
        error.value = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        loading.value = false;
        inflight = null;
      });
    return inflight;
  }

  const find = (name: string): ReportInfo | undefined => reports.value.find((r) => r.name === name);

  return { reports, categories, loaded, loading, error, load, find };
});
