import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, buildQuery, onUnauthorized, setCsrfToken, setFetch } from '@/api/client';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  setFetch(fn as unknown as typeof fetch);
  return fn;
}

afterEach(() => {
  setCsrfToken(null);
  onUnauthorized(null);
  document.cookie = 'qbv_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

describe('buildQuery', () => {
  it('serialises filters, arrays and skips empty values', () => {
    expect(
      buildQuery({
        q: 'smith',
        page: 2,
        empty: '',
        none: undefined,
        filter: { TxnDate: 'gte:2024-01-01', x: null },
        tag: ['a', 'b'],
      }),
    ).toBe('?q=smith&page=2&filter%5BTxnDate%5D=gte%3A2024-01-01&tag=a&tag=b');
    expect(buildQuery({})).toBe('');
  });
});

describe('api client', () => {
  it('GETs JSON with credentials and without a CSRF header', async () => {
    setCsrfToken('tok');
    const f = mockFetch(200, { items: [] });
    expect(await api.get('/objects/Customer', { query: { page: 1 } })).toEqual({ items: [] });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/objects/Customer?page=1');
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();
  });

  it('sends JSON bodies and the CSRF token on writes', async () => {
    setCsrfToken('tok-1');
    const f = mockFetch(202, { commandId: 'c1' });
    expect(await api.post('/objects/Customer', { Name: 'A' })).toEqual({ commandId: 'c1' });
    const init = f.mock.calls[0]![1]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"Name":"A"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok-1');
  });

  it('falls back to the qbv_csrf cookie', async () => {
    document.cookie = 'qbv_csrf=from-cookie';
    const f = mockFetch(204, undefined);
    await api.del('/objects/Customer/1');
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'from-cookie',
    );
  });

  it('turns error envelopes into ApiError and notifies on 401', async () => {
    mockFetch(409, {
      error: { code: 'conflict', message: 'EditSequence out of date', details: { current: 1 } },
    });
    const err = await api.patch('/objects/Customer/1', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'EditSequence out of date',
      details: { current: 1 },
    });
    expect((err as ApiError).isConflict).toBe(true);

    const seen: ApiError[] = [];
    onUnauthorized((e) => seen.push(e));
    mockFetch(401, { error: { code: 'unauthenticated', message: 'Login required' } });
    await expect(api.get('/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(seen).toHaveLength(1);
  });

  it('reports network failures', async () => {
    setFetch((async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    await expect(api.get('/health')).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });
});
