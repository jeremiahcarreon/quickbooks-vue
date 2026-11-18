import { api, ApiError, type QueryParams } from '@/api/client';
import type { ParamValues, ReportCatalog, ReportResult } from './types';

export function listReports(signal?: AbortSignal): Promise<ReportCatalog> {
  return api.get<ReportCatalog>('/reports', { signal });
}

type RunResponse =
  | ({ status: 'ready' } & ReportResult)
  | { status: 'pending'; commandId: string; commandStatus: string };

/** Drop empty values; arrays become repeated query keys. */
export function paramsToQuery(params: ParamValues): QueryParams {
  const q: QueryParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    q[k] = v;
  }
  return q;
}

export interface RunOptions {
  refresh?: boolean;
  signal?: AbortSignal;
  /** Called while QuickBooks is still working on the report. */
  onPending?: (info: { commandId: string; commandStatus: string; attempt: number }) => void;
  /** Delay between polls in ms (default 1500). */
  pollMs?: number;
  /** Give up after this long in ms (default 5 minutes). */
  timeoutMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/**
 * Run a report. QuickBooks reports may answer "pending" while the request
 * waits in the relay queue; this keeps asking with the returned commandId
 * until the result is ready.
 */
export async function runReport(
  name: string,
  params: ParamValues,
  opts: RunOptions = {},
): Promise<ReportResult> {
  const path = `/reports/${encodeURIComponent(name)}`;
  const started = Date.now();
  const timeout = opts.timeoutMs ?? 5 * 60_000;
  let res = await api.get<RunResponse>(path, {
    query: { ...paramsToQuery(params), refresh: opts.refresh ? 'true' : undefined },
    signal: opts.signal,
  });
  let attempt = 0;
  while (res.status === 'pending') {
    attempt++;
    opts.onPending?.({ commandId: res.commandId, commandStatus: res.commandStatus, attempt });
    if (Date.now() - started > timeout) {
      throw new ApiError(
        504,
        'timeout',
        'QuickBooks did not return the report in time. Try again later.',
      );
    }
    await sleep(opts.pollMs ?? 1500, opts.signal);
    res = await api.get<RunResponse>(path, {
      query: { ...paramsToQuery(params), commandId: res.commandId },
      signal: opts.signal,
    });
  }
  const { status: _status, ...result } = res;
  return result;
}
