/**
 * Fetch wrapper for the QuickBooks Vue API.
 * - Same-origin cookie session (credentials: 'include').
 * - CSRF: state-changing requests send `X-CSRF-Token`, taken from
 *   setCsrfToken() (e.g. the value returned by /auth/me or /auth/login) or,
 *   failing that, from the `qbv_csrf` cookie.
 * - Errors follow `{ error: { code, message, details? } }` and surface as ApiError.
 */

export const API_BASE = '/api';
export const CSRF_HEADER = 'X-CSRF-Token';
export const CSRF_COOKIE = 'qbv_csrf';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | QueryValue[] | Record<string, QueryValue>>;

export interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Return the raw Response instead of parsed JSON. */
  raw?: boolean;
}

let csrfToken: string | null = null;
let unauthorizedHandler: ((err: ApiError) => void) | null = null;
let fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args);

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called on every 401 (e.g. to route to the login screen). */
export function onUnauthorized(handler: ((err: ApiError) => void) | null): void {
  unauthorizedHandler = handler;
}

/** For tests. */
export function setFetch(impl: typeof fetch): void {
  fetchImpl = impl;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * Serialise query params. Objects become bracketed keys, which is how the
 * list endpoint takes filters: `{ filter: { TxnDate: 'gte:2024-01-01' } }`
 * -> `filter[TxnDate]=gte%3A2024-01-01`. Arrays repeat the key.
 */
export function buildQuery(params: QueryParams = {}): string {
  const sp = new URLSearchParams();
  const add = (k: string, v: QueryValue) => {
    if (v === undefined || v === null || v === '') return;
    sp.append(k, String(v));
  };
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((v) => add(key, v));
    else if (value !== null && typeof value === 'object') {
      for (const [sub, v] of Object.entries(value)) add(`${key}[${sub}]`, v);
    } else add(key, value);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function request<T = unknown>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const m = method.toUpperCase();
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (
      typeof opts.body === 'string' ||
      opts.body instanceof FormData ||
      opts.body instanceof Blob
    ) {
      body = opts.body as BodyInit;
    } else {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
  }
  if (!SAFE_METHODS.has(m)) {
    const token = csrfToken ?? readCookie(CSRF_COOKIE);
    if (token) headers[CSRF_HEADER] = token;
  }
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}${buildQuery(opts.query)}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: m,
      headers,
      body,
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Check your connection.');
  }
  if (opts.raw && res.ok) return res as unknown as T;

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const e = (
      data as { error?: { code?: string; message?: string; details?: unknown } } | undefined
    )?.error;
    const err = new ApiError(
      res.status,
      e?.code ?? `http_${res.status}`,
      e?.message ??
        (typeof data === 'string' && data
          ? data
          : res.statusText || `Request failed (${res.status})`),
      e?.details,
    );
    if (res.status === 401) unauthorizedHandler?.(err);
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T = unknown>(path: string, opts?: Omit<RequestOptions, 'body'>) =>
    request<T>('GET', path, opts),
  post: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('POST', path, { ...opts, body }),
  patch: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('PATCH', path, { ...opts, body }),
  put: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('PUT', path, { ...opts, body }),
  del: <T = unknown>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
};
