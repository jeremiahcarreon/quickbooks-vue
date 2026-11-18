import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildRequest, validate } from '@qbv/qbxml';
import {
  RelayAuthError,
  RelayBadRequestError,
  RelayClient,
  RelayForbiddenError,
  RelayNetworkError,
  RelayProtocolError,
  RelayQbError,
  RelayTimeoutError,
  RelayUnavailableError,
  RelayValidationError,
  relayClientFromConfig,
} from '../src/index.js';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let handler: Handler;
let received: {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}[] = [];
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  received = [];
});

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Every request in these tests is built by @qbv/qbxml and must be XSD-valid. */
function request(): string {
  const xml = buildRequest('CustomerQueryRq', { MaxReturned: '5' });
  expect(validate(xml).valid).toBe(true);
  return xml;
}

const RESPONSE =
  '<?xml version="1.0" ?><QBXML><QBXMLMsgsRs><CustomerQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"/></QBXMLMsgsRs></QBXML>';

describe('RelayClient.request', () => {
  it('validates, sends {qbxml} with X-Api-Key and returns the response', async () => {
    handler = (_req, _body, res) => json(res, 200, { response: RESPONSE, error: null });
    const client = new RelayClient({ baseUrl: baseUrl + '/', apiKey: 'k1' });
    const xml = request();
    expect(await client.request(xml)).toBe(RESPONSE);
    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe('POST');
    expect(received[0]!.url).toBe('/qb/request');
    expect(received[0]!.headers['x-api-key']).toBe('k1');
    expect(received[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(received[0]!.body)).toEqual({ qbxml: xml });
  });

  it('refuses to send XSD-invalid qbXML', async () => {
    handler = (_req, _body, res) => json(res, 200, { response: RESPONSE, error: null });
    const client = new RelayClient({ baseUrl });
    const bad = request().replace(
      '<MaxReturned>5</MaxReturned>',
      '<MaxReturned>5</MaxReturned><Nope/>',
    );
    expect(validate(bad).valid).toBe(false);
    const err = await client.request(bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayValidationError);
    expect((err as RelayValidationError).errors[0]!.message).toMatch(/Nope/);
    await expect(client.request('<QBXML>')).rejects.toBeInstanceOf(RelayValidationError);
    expect(received).toHaveLength(0);
  });

  it('uses an injected validator', async () => {
    handler = (_req, _body, res) => json(res, 200, { response: RESPONSE, error: null });
    const calls: string[] = [];
    const client = new RelayClient({
      baseUrl,
      validator: (xml) => {
        calls.push(xml);
        return { valid: false, errors: [{ line: 1, message: 'custom' }] };
      },
    });
    await expect(client.request(request())).rejects.toThrow(/custom/);
    expect(calls).toHaveLength(1);
  });

  it.each([
    [400, RelayBadRequestError, false, false],
    [401, RelayAuthError, false, false],
    [403, RelayForbiddenError, false, false],
    [502, RelayQbError, false, true],
    [503, RelayUnavailableError, true, false],
    [504, RelayTimeoutError, true, true],
  ] as const)('maps HTTP %i to %o', async (status, Cls, retryable, mayHaveExecuted) => {
    handler = (_req, _body, res) => json(res, status, { error: `boom ${status}` });
    const err = await new RelayClient({ baseUrl }).request(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Cls);
    expect(err).toMatchObject({ status, retryable, mayHaveExecuted, message: `boom ${status}` });
  });

  it('treats a 200 with an error field as a QuickBooks failure', async () => {
    handler = (_req, _body, res) => json(res, 200, { response: null, error: 'COM failure' });
    await expect(new RelayClient({ baseUrl }).request(request())).rejects.toBeInstanceOf(
      RelayQbError,
    );
  });

  it('flags non-contract responses', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(200);
      res.end('<html>proxy</html>');
    };
    await expect(new RelayClient({ baseUrl }).request(request())).rejects.toBeInstanceOf(
      RelayProtocolError,
    );
  });

  it('times out on the client side', async () => {
    handler = (_req, _body, res) => setTimeout(() => json(res, 200, { response: RESPONSE }), 500);
    const err = await new RelayClient({ baseUrl, timeoutMs: 50 })
      .request(request())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayTimeoutError);
    expect(err).toMatchObject({ retryable: true, mayHaveExecuted: true });
  });

  it('reports refused connections as retryable and not executed', async () => {
    const tmp = createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    const err = await new RelayClient({ baseUrl: `http://127.0.0.1:${port}` })
      .request(request())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayNetworkError);
    expect(err).toMatchObject({ retryable: true, mayHaveExecuted: false });
  });

  it('honours a caller abort signal', async () => {
    handler = (_req, _body, res) => setTimeout(() => json(res, 200, { response: RESPONSE }), 500);
    const ac = new AbortController();
    const p = new RelayClient({ baseUrl }).request(request(), { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow();
  });
});

describe('RelayClient.health', () => {
  it('returns the relay health document', async () => {
    handler = (_req, _body, res) =>
      json(res, 200, {
        connected: true,
        lastError: null,
        lastRequestTime: '2026-01-01T00:00:00Z',
        uptime: 12.5,
      });
    const c = relayClientFromConfig({
      RELAY_URL: baseUrl,
      RELAY_API_KEY: 'k',
      RELAY_TIMEOUT_MS: 1000,
    });
    expect(await c.health()).toEqual({
      connected: true,
      lastError: null,
      lastRequestTime: '2026-01-01T00:00:00Z',
      uptime: 12.5,
    });
    expect(received[0]).toMatchObject({ method: 'GET', url: '/qb/health' });
    expect(received[0]!.headers['x-api-key']).toBe('k');
    expect(await c.ping()).toMatchObject({ ok: true, connected: true });
  });

  it('ping never throws', async () => {
    handler = (_req, _body, res) => json(res, 401, { error: 'Invalid API key' });
    expect(await new RelayClient({ baseUrl }).ping()).toMatchObject({
      ok: false,
      connected: false,
      error: 'Invalid API key',
    });
    handler = (_req, _body, res) => json(res, 200, { nope: 1 });
    await expect(new RelayClient({ baseUrl }).health()).rejects.toBeInstanceOf(RelayProtocolError);
  });
});
