import {
  RelayAuthError,
  RelayBadRequestError,
  RelayError,
  RelayForbiddenError,
  RelayNetworkError,
  RelayNotFoundError,
  RelayProtocolError,
  RelayQbError,
  RelayTimeoutError,
  RelayUnavailableError,
  RelayValidationError,
} from './errors.js';

export interface RelayHealth {
  connected: boolean;
  lastError: string | null;
  lastRequestTime: string | null;
  uptime: number;
  /** Any extra fields the relay reports. */
  [key: string]: unknown;
}

export interface QbxmlValidator {
  (xml: string): { valid: boolean; errors: { line: number; message: string }[] };
}

export interface RelayClientOptions {
  /** e.g. http://10.0.0.5:9123 (RELAY_URL). */
  baseUrl: string;
  /** Sent as X-Api-Key (RELAY_API_KEY). */
  apiKey?: string;
  /** Client-side timeout for POST /qb/request (default 130000 ms). */
  timeoutMs?: number;
  /** Timeout for GET /qb/health (default 5000 ms). */
  healthTimeoutMs?: number;
  /**
   * XSD validator run before every send. Defaults to @qbv/qbxml `validate`.
   * There is no way to switch validation off.
   */
  validator?: QbxmlValidator;
  fetch?: typeof fetch;
}

const NOT_EXECUTED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

let defaultValidatorPromise: Promise<QbxmlValidator> | undefined;
function loadDefaultValidator(): Promise<QbxmlValidator> {
  defaultValidatorPromise ??= (async () => {
    const spec = '@qbv/qbxml';
    const mod = (await import(spec)) as { validate?: QbxmlValidator };
    if (typeof mod.validate !== 'function')
      throw new Error('@qbv/qbxml does not export validate()');
    return mod.validate;
  })();
  return defaultValidatorPromise;
}

function errorMessage(body: string, fallback: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown };
    if (typeof j.error === 'string' && j.error) return j.error;
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 500) || fallback;
}

function statusError(status: number, body: string): RelayError {
  const msg = errorMessage(body, `Relay responded ${status}`);
  switch (status) {
    case 400:
      return new RelayBadRequestError(msg, { body });
    case 401:
      return new RelayAuthError(msg, { body });
    case 403:
      return new RelayForbiddenError(msg, { body });
    case 404:
      return new RelayNotFoundError(msg, { body });
    case 502:
      return new RelayQbError(msg, { body });
    case 503:
      return new RelayUnavailableError(msg, { body });
    case 504:
      return new RelayTimeoutError(msg, { status, body });
    default:
      return status >= 500
        ? new RelayError(msg, { status, body, retryable: true, mayHaveExecuted: true })
        : new RelayError(msg, { status, body });
  }
}

function causeCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Client for the relay contract: POST /qb/request {qbxml} -> {response, error}; GET /qb/health. */
export class RelayClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly validator?: QbxmlValidator;

  constructor(opts: RelayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? '';
    this.timeoutMs = opts.timeoutMs ?? 130_000;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 5000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.validator = opts.validator;
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (timeout.aborted) {
        throw new RelayTimeoutError(`Relay did not answer within ${timeoutMs} ms`, { cause: err });
      }
      if (signal?.aborted) throw err;
      const code = causeCode(err);
      throw new RelayNetworkError(
        `Cannot reach relay at ${this.baseUrl}: ${code ?? (err as Error).message}`,
        {
          cause: err,
          mayHaveExecuted: method === 'POST' && !(code && NOT_EXECUTED_CODES.has(code)),
        },
      );
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (timeout.aborted)
        throw new RelayTimeoutError(`Relay did not answer within ${timeoutMs} ms`, { cause: err });
      throw new RelayNetworkError(`Relay connection dropped: ${(err as Error).message}`, {
        cause: err,
        mayHaveExecuted: method === 'POST',
      });
    }
    if (!res.ok) throw statusError(res.status, text);
    return text;
  }

  /** Validate the document against the XSD; throws RelayValidationError. */
  async validate(qbxml: string): Promise<void> {
    const v = this.validator ?? (await loadDefaultValidator());
    const r = v(qbxml);
    if (!r.valid)
      throw new RelayValidationError(
        r.errors.length ? r.errors : [{ line: 0, message: 'invalid' }],
      );
  }

  /**
   * Validate `qbxml` against the XSD, send it and return QuickBooks' response
   * document. Throws a RelayError subclass on any failure.
   */
  async request(
    qbxml: string,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<string> {
    await this.validate(qbxml);
    const text = await this.call(
      'POST',
      '/qb/request',
      { qbxml },
      opts.timeoutMs ?? this.timeoutMs,
      opts.signal,
    );
    let parsed: { response?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch (err) {
      throw new RelayProtocolError('Relay returned invalid JSON', {
        body: text,
        cause: err,
        mayHaveExecuted: true,
      });
    }
    if (typeof parsed.error === 'string' && parsed.error) {
      throw new RelayQbError(parsed.error, { status: 200, body: text });
    }
    if (typeof parsed.response !== 'string') {
      throw new RelayProtocolError('Relay response has no "response" string', {
        body: text,
        mayHaveExecuted: true,
      });
    }
    return parsed.response;
  }

  /** GET /qb/health. Throws a RelayError when the relay is unreachable or rejects us. */
  async health(opts: { signal?: AbortSignal } = {}): Promise<RelayHealth> {
    const text = await this.call('GET', '/qb/health', undefined, this.healthTimeoutMs, opts.signal);
    try {
      const h = JSON.parse(text) as Partial<RelayHealth>;
      if (typeof h.connected !== 'boolean') throw new Error('missing "connected"');
      return {
        ...h,
        connected: h.connected,
        lastError: h.lastError ?? null,
        lastRequestTime: h.lastRequestTime ?? null,
        uptime: typeof h.uptime === 'number' ? h.uptime : 0,
      };
    } catch (err) {
      throw new RelayProtocolError(`Invalid health response: ${(err as Error).message}`, {
        body: text,
        cause: err,
      });
    }
  }

  /** Health check that never throws: reachable + QuickBooks connected. */
  async ping(): Promise<{ ok: boolean; connected: boolean; latencyMs: number; error?: string }> {
    const started = performance.now();
    try {
      const h = await this.health();
      return {
        ok: true,
        connected: h.connected,
        latencyMs: Math.round(performance.now() - started),
        error: h.lastError ?? undefined,
      };
    } catch (err) {
      return {
        ok: false,
        connected: false,
        latencyMs: Math.round(performance.now() - started),
        error: (err as Error).message,
      };
    }
  }

  /** POST /qb/restart: restart the relay's QuickBooks worker thread. */
  async restart(): Promise<void> {
    await this.call('POST', '/qb/restart', {}, this.healthTimeoutMs);
  }
}

/** Build a client from @qbv/config values. */
export function relayClientFromConfig(
  config: { RELAY_URL: string; RELAY_API_KEY: string; RELAY_TIMEOUT_MS: number },
  extra: Omit<RelayClientOptions, 'baseUrl' | 'apiKey' | 'timeoutMs'> = {},
): RelayClient {
  return new RelayClient({
    baseUrl: config.RELAY_URL,
    apiKey: config.RELAY_API_KEY,
    timeoutMs: config.RELAY_TIMEOUT_MS,
    ...extra,
  });
}
