/** Summary of GET /admin/sync (one sync_state row per object type). */

export interface SyncSummary {
  types: number;
  running: number;
  /** Types whose last run failed. */
  errors: string[];
  /** Most recent last_run_at (ISO), if any. */
  lastRun?: string;
}

function rowsOf(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const k of ['states', 'items', 'types', 'rows', 'data', 'state']) {
      if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
    }
  }
  return [];
}

const s = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function summarizeSync(raw: unknown): SyncSummary {
  const rows = rowsOf(raw);
  let lastRun: string | undefined;
  const errors: string[] = [];
  let running = 0;
  for (const r of rows) {
    const type = s(r.type) ?? s(r.objectType) ?? '?';
    const status = (s(r.status) ?? '').toLowerCase();
    const at = s(r.last_run_at) ?? s(r.lastRunAt);
    if (at && (!lastRun || Date.parse(at) > Date.parse(lastRun))) lastRun = at;
    if (['running', 'syncing', 'loading', 'reconciling'].includes(status)) running += 1;
    if (status === 'error' || status === 'failed' || s(r.error)) errors.push(type);
  }
  return { types: rows.length, running, errors, lastRun };
}
