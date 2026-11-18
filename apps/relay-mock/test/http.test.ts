import { networkInterfaces } from 'node:os';
import { buildRequest, parseResponse } from '@qbv/qbxml';
import {
  RelayClient,
  RelayQbError,
  RelayTimeoutError,
  RelayUnavailableError,
  RelayAuthError,
  RelayNetworkError,
} from '@qbv/relay-client';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { QB_PARSE_ERROR } from '../src/server.js';
import { startRelayMock, type StartedRelayMock } from '../src/start.js';
import { expectValid } from './helpers.js';

const KEY = 'test-key';
let relay: StartedRelayMock | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

async function start(opts: Parameters<typeof startRelayMock>[0] = {}) {
  relay = await startRelayMock({ apiKey: KEY, ...opts });
  return relay;
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const getJson = async (path: string): Promise<J> =>
  (await (await fetch(`${relay!.url}${path}`, { headers: { 'x-api-key': KEY } })).json()) as J;

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = { 'x-api-key': KEY },
) {
  const res = await fetch(`${relay!.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return {
    status: res.status,
    headers: res.headers,
    json: (await res.json()) as Record<string, unknown>,
  };
}

const customerQuery = () => buildRequest('CustomerQueryRq', { MaxReturned: 5 }, { requestID: '1' });

describe('relay HTTP contract', () => {
  it('POST /qb/request returns {response, error} with an XSD-valid response', async () => {
    await start({ seed: true });
    const r = await post('/qb/request', { qbxml: customerQuery() });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(['response', 'error']);
    expect(r.json.error).toBeNull();
    expectValid(String(r.json.response));
    const [rs] = parseResponse(String(r.json.response));
    expect(rs).toMatchObject({ name: 'CustomerQueryRs', requestID: '1', statusCode: 0 });
    expect(rs!.rets).toHaveLength(5);
    // Property name is case-insensitive like System.Text.Json's.
    expect((await post('/qb/request', { QBXML: customerQuery() })).status).toBe(200);
  });

  it('authenticates with X-Api-Key and answers like the relay for bad input', async () => {
    await start();
    expect((await post('/qb/request', { qbxml: customerQuery() }, {})).status).toBe(401);
    expect(
      (await post('/qb/request', { qbxml: customerQuery() }, { 'x-api-key': 'nope' })).json,
    ).toEqual({ error: 'Invalid API key' });
    const health = await fetch(`${relay!.url}/qb/health`);
    expect(health.status).toBe(401);
    expect(await post('/qb/request', {})).toMatchObject({
      status: 400,
      json: { error: "Missing 'qbxml' field in request body" },
    });
    expect((await post('/qb/request', '{not json')).status).toBe(500);
    const nf = await fetch(`${relay!.url}/nope`, { headers: { 'x-api-key': KEY } });
    expect(nf.status).toBe(404);
  });

  it('rejects malformed XML before "sending to QuickBooks" (502)', async () => {
    await start();
    const r = await post('/qb/request', {
      qbxml:
        '<?xml version="1.0"?><QBXML><QBXMLMsgsRq onError="stopOnError"><CustomerQueryRq></QBXMLMsgsRq></QBXML>',
    });
    expect(r.status).toBe(502);
    expect(String(r.json.error)).toMatch(
      /^Malformed XML rejected before sending to QB: Line \d+, Position \d+: /,
    );
    const log = await (
      await fetch(`${relay!.url}/qb/errors`, { headers: { 'x-api-key': KEY } })
    ).text();
    expect(log).toContain('[XML_VALIDATION]');
  });

  it("returns QuickBooks' parse error (502) for schema-invalid qbXML and logs it", async () => {
    await start();
    // Elements out of order: well-formed but not valid against the XSD.
    const bad = customerQuery().replace(
      '<MaxReturned>5</MaxReturned>',
      '<IncludeRetElement>Name</IncludeRetElement><MaxReturned>5</MaxReturned>',
    );
    const r = await post('/qb/request', { qbxml: bad });
    expect(r.status).toBe(502);
    expect(r.json).toEqual({ error: QB_PARSE_ERROR });
    expect(r.headers.get('x-mock-validation-error')).toMatch(/line \d+/);
    const unknownElement = customerQuery().replace(
      '<MaxReturned>5</MaxReturned>',
      '<Bogus>1</Bogus>',
    );
    expect((await post('/qb/request', { qbxml: unknownElement })).json).toEqual({
      error: QB_PARSE_ERROR,
    });
    const noVersion = customerQuery().replace(/<\?qbxml[^>]*\?>/, '');
    expect((await post('/qb/request', { qbxml: noVersion })).status).toBe(502);
    const log = await (
      await fetch(`${relay!.url}/qb/errors`, { headers: { 'x-api-key': KEY } })
    ).text();
    expect(log).toContain('[QB_PARSE_REJECT] HRESULT 0x80040400');
    expect(log).toContain('Request: <?xml');
    // Nothing was processed.
    expect(relay!.mock.requestLog.every((l) => l.requests.length === 0)).toBe(true);
  });

  it('health, restart and the disconnected fault', async () => {
    await start();
    const h = await getJson('/qb/health');
    expect(h).toMatchObject({ connected: true, lastError: null, lastRequestTime: null });
    expect(typeof h.uptime).toBe('number');
    await post('/mock/faults', { mode: 'disconnected', count: 0 });
    expect((await getJson('/qb/health')).connected).toBe(false);
    expect(await post('/qb/request', { qbxml: customerQuery() })).toMatchObject({ status: 503 });
    expect(await post('/qb/request', { qbxml: customerQuery() })).toMatchObject({ status: 503 });
    expect(await post('/qb/restart', {})).toMatchObject({ status: 200, json: { restarted: true } });
    expect((await post('/qb/request', { qbxml: customerQuery() })).status).toBe(200);
    const h2 = await getJson('/qb/health');
    expect(h2.lastRequestTime).toMatch(/^\d{4}-/);
  });

  it('IP allowlist (403) applies to non-loopback clients', async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!lan) return; // no non-loopback interface in this environment
    relay = await startRelayMock({ apiKey: KEY, allowedIps: ['10.255.255.1'], host: '0.0.0.0' });
    const viaLan = await fetch(`http://${lan}:${relay.port}/qb/health`, {
      headers: { 'x-api-key': KEY },
    });
    expect(viaLan.status).toBe(403);
    expect(await viaLan.json()).toEqual({ error: 'IP not allowed' });
    const viaLoopback = await fetch(`http://127.0.0.1:${relay.port}/qb/health`, {
      headers: { 'x-api-key': KEY },
    });
    expect(viaLoopback.status).toBe(200);
  });

  it('processes one request at a time with the configured latency', async () => {
    await start({ latencyMs: 60 });
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post('/qb/request', { qbxml: customerQuery() })),
    );
    const elapsed = Date.now() - t0;
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(5 * 60 - 10);
    // Strictly serial: no two requests overlap.
    const log = relay!.mock.requestLog;
    for (let i = 1; i < log.length; i++)
      expect(Date.parse(log[i]!.at)).toBeGreaterThanOrEqual(
        Date.parse(log[i - 1]!.at) + log[i - 1]!.ms - 5,
      );
    await post('/mock/latency', { ms: 0 });
    expect(relay!.mock.latencyMs).toBe(0);
  });

  it('control endpoints: state, reset with seed, export / import, clock', async () => {
    await start();
    const s0 = await getJson('/mock/state');
    expect(s0.objects).toEqual({ Company: 1, Host: 1, Preferences: 1 });
    const seeded = await post('/mock/reset', { seed: true });
    expect((seeded.json.objects as Record<string, number>).Invoice).toBeGreaterThan(20);
    const exported = await getJson('/mock/export');
    await post('/mock/reset', {});
    expect((await post('/mock/import', exported)).json.total).toBe(exported.records.length);
    const clock = await post('/mock/clock', { now: '2030-01-02T03:04:05Z' });
    expect(String(clock.json.now)).toMatch(/^2030-01-02T03:04/);
    await post('/qb/request', { qbxml: buildRequest('ClassAddRq', { Name: 'Future' }) });
    const res = await post('/qb/request', {
      qbxml: buildRequest('ClassQueryRq', { FullName: 'Future' }),
    });
    // ListIDs carry the creation time in seconds (2030-01-02T03:04:05Z = 1893553445).
    expect(parseResponse(String(res.json.response))[0]!.rets[0]!.ListID).toMatch(
      /^[0-9A-F]{8}-18935534\d\d$/,
    );
  });
});

describe('with @qbv/relay-client', () => {
  it('round-trips requests and maps every fault to the right error', async () => {
    await start({ seed: true, requestTimeoutMs: 50 });
    const client = new RelayClient({ baseUrl: relay!.url, apiKey: KEY, timeoutMs: 2000 });
    const xml = await client.request(customerQuery());
    expectValid(xml);
    expect((await client.health()).connected).toBe(true);

    const fault = (body: Record<string, unknown>) => post('/mock/faults', body);
    await fault({ mode: 'disconnected' });
    await expect(client.request(customerQuery())).rejects.toBeInstanceOf(RelayUnavailableError);
    await fault({ mode: 'timeout', delayMs: 10 });
    await expect(client.request(customerQuery())).rejects.toBeInstanceOf(RelayTimeoutError);
    await fault({ mode: 'error', message: 'Exception from HRESULT: 0x8004041A' });
    const err = await client.request(customerQuery()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayQbError);
    expect((err as Error).message).toContain('0x8004041A');
    await fault({ mode: 'drop' });
    await expect(client.request(customerQuery())).rejects.toBeInstanceOf(RelayNetworkError);
    // A hung request: the client gives up first; the relay answers 504 later.
    await fault({ mode: 'timeout', delayMs: 400 });
    const short = new RelayClient({ baseUrl: relay!.url, apiKey: KEY, timeoutMs: 100 });
    await expect(short.request(customerQuery())).rejects.toBeInstanceOf(RelayTimeoutError);
    await new Promise((r) => setTimeout(r, 400));
    // executeThenTimeout: the write happens, but the caller sees a 504.
    await fault({ mode: 'executeThenTimeout' });
    await expect(
      client.request(buildRequest('ClassAddRq', { Name: 'Ghost' })),
    ).rejects.toBeInstanceOf(RelayTimeoutError);
    const q = parseResponse(
      await client.request(buildRequest('ClassQueryRq', { FullName: 'Ghost' })),
    );
    expect(q[0]!.rets).toHaveLength(1);
    const bad = new RelayClient({ baseUrl: relay!.url, apiKey: 'wrong' });
    await expect(bad.request(customerQuery())).rejects.toBeInstanceOf(RelayAuthError);
  }, 20_000);
});

describe('engine wiring', () => {
  it('an injected engine is used as-is', async () => {
    const engine = new Engine({ companyName: 'Injected Co' });
    await start({ engine });
    const r = await post('/qb/request', { qbxml: buildRequest('CompanyQueryRq', {}) });
    expect(parseResponse(String(r.json.response))[0]!.rets[0]!.CompanyName).toBe('Injected Co');
  });
});
