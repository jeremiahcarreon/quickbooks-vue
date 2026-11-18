/** Fetch mock for the API client, recording calls. */
import { vi } from 'vitest';
import { setFetch } from '@/api/client';

export type Handler = (
  method: string,
  url: string,
  body: unknown,
) => { status: number; body?: unknown };

export interface Call {
  method: string;
  url: string;
  body: unknown;
}

export function mockApi(handler: Handler): Call[] {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: decodeURIComponent(String(url)), body });
    const res = handler(method, decodeURIComponent(String(url)), body);
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  setFetch(fn as unknown as typeof fetch);
  return calls;
}

export const notFound = {
  status: 404,
  body: { error: { code: 'not_found', message: 'not found' } },
};

/** A read-model page of rows. */
export function page(type: string, datas: Record<string, unknown>[]) {
  return {
    status: 200,
    body: {
      items: datas.map((d) => ({
        type,
        qb_id: (d.TxnID ?? d.ListID) as string,
        name: (d.FullName ?? d.Name) as string | undefined,
        time_modified: d.TimeModified,
        data: d,
      })),
      total: datas.length,
      page: 1,
      pageSize: 500,
    },
  };
}
