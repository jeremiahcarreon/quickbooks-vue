/**
 * Route-based fetch mock for component/store tests. Handlers are matched on
 * "METHOD /path" (path without /api and without the query string).
 */
import { vi } from 'vitest';
import { setFetch } from '@/api/client';

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}
export type MockReply = { status?: number; body?: unknown } | unknown;
export type Handler = (req: MockRequest) => MockReply | Promise<MockReply>;

export function mockApi(routes: Record<string, Handler>) {
  const calls: MockRequest[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api/, '');
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // raw text (e.g. qbXML)
      }
    }
    const req: MockRequest = {
      method,
      path,
      query: url.searchParams,
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(req);
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      if (m !== method) return false;
      const re = new RegExp(`^${p!.replace(/:[^/]+/g, '[^/]+')}$`);
      return re.test(path);
    });
    if (!key) {
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: `No mock for ${method} ${path}` } }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    const out = (await routes[key]!(req)) as { status?: number; body?: unknown } | undefined;
    const isEnvelope =
      out &&
      typeof out === 'object' &&
      ('status' in out || 'body' in out) &&
      Object.keys(out).every((k) => k === 'status' || k === 'body');
    const status = isEnvelope ? (out.status ?? 200) : 200;
    const payload = isEnvelope ? out.body : out;
    return new Response(
      payload === undefined
        ? null
        : typeof payload === 'string'
          ? payload
          : JSON.stringify(payload),
      {
        status,
        headers: {
          'content-type': typeof payload === 'string' ? 'application/xml' : 'application/json',
        },
      },
    );
  });
  setFetch(fn as unknown as typeof fetch);
  return { fn, calls };
}

export const ADMIN = {
  user: {
    id: 'u1',
    email: 'admin@example.test',
    displayName: 'Admin',
    permissions: ['admin'],
    roles: ['Admin'],
  },
  csrfToken: 'csrf-1',
};
export const CLERK = {
  user: {
    id: 'u2',
    email: 'clerk@example.test',
    display_name: 'Clerk',
    permissions: ['object:*:read', 'object:Customer:write'],
    roles: ['Sales'],
  },
};
