import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildRequest, buildResponse, validate, type ResponsePart } from '@qbv/qbxml';
import { createCommand, type Db, type NewCommandInput } from '@qbv/db';
import type { QbvEvent } from '@qbv/queue';
import { RelayClient } from '@qbv/relay-client';
import { describeRequest, type RequestInfo } from '../src/request-info.js';
import type { EventPublisher } from '../src/types.js';

export type Reply =
  | { xml: string }
  | { status: number; body?: unknown }
  /** Never answer (the client times out). */
  | { hang: true };

export interface RecordedRequest {
  qbxml: string;
  valid: boolean;
  errors: { line: number; message: string }[];
  info?: RequestInfo;
  rqNames: string[];
}

export type Handler = (qbxml: string, info: RequestInfo) => Reply | Promise<Reply>;

/**
 * A tiny stand-in for the relay (POST /qb/request, GET /qb/health). Every
 * document it receives is validated against the XSD and recorded, so tests
 * can assert that nothing invalid was ever sent.
 */
export class FakeRelay {
  readonly requests: RecordedRequest[] = [];
  handler: Handler = () => ({ status: 503, body: { error: 'no handler' } });
  health: { status: number; body: unknown } = {
    status: 200,
    body: { connected: true, lastError: null, lastRequestTime: null, uptime: 1 },
  };
  healthCalls = 0;
  /** Exceptions thrown by handlers (assertions inside handlers land here). */
  readonly handlerErrors: Error[] = [];
  apiKey = 'test-key';
  private server: Server | undefined;
  private hanging = new Set<ServerResponse>();
  url = '';

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    for (const r of this.hanging) r.destroy();
    this.hanging.clear();
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  client(opts: { timeoutMs?: number } = {}): RelayClient {
    return new RelayClient({
      baseUrl: this.url,
      apiKey: this.apiKey,
      timeoutMs: opts.timeoutMs ?? 5000,
      healthTimeoutMs: 1000,
    });
  }

  /** Names of the request elements of every document received, in order. */
  get sentRqs(): string[][] {
    return this.requests.map((r) => r.rqNames);
  }

  get invalid(): RecordedRequest[] {
    return this.requests.filter((r) => !r.valid);
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-api-key'] !== this.apiKey) return send(401, { error: 'Invalid API key' });
    if (req.method === 'GET' && req.url === '/qb/health') {
      this.healthCalls++;
      return send(this.health.status, this.health.body);
    }
    if (req.method !== 'POST' || req.url !== '/qb/request')
      return send(404, { error: 'not found' });
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const { qbxml } = JSON.parse(raw) as { qbxml: string };
    const v = validate(qbxml);
    let info: RequestInfo | undefined;
    try {
      info = describeRequest(qbxml);
    } catch {
      info = undefined;
    }
    this.requests.push({
      qbxml,
      valid: v.valid,
      errors: v.errors,
      info,
      rqNames: info?.rqs.map((r) => r.name) ?? [],
    });
    if (!v.valid || !info) {
      // What QuickBooks does with a document it cannot parse.
      return send(502, {
        error: 'QuickBooks found an error when parsing the provided XML text stream.',
      });
    }
    let reply: Reply;
    try {
      reply = await this.handler(qbxml, info);
    } catch (err) {
      this.handlerErrors.push(err as Error);
      return send(400, { error: `test handler failed: ${(err as Error).message}` });
    }
    if ('hang' in reply) {
      this.hanging.add(res);
      return;
    }
    if ('xml' in reply) return send(200, { response: reply.xml, error: null });
    return send(reply.status, reply.body ?? { error: `status ${reply.status}` });
  }
}

/** A validated QuickBooks-style response document. */
export function respond(...parts: ResponsePart[]): Reply {
  const xml = buildResponse(parts);
  if (!validate(xml).valid) throw new Error('test response is not XSD-valid');
  return { xml };
}

export const T0 = '2026-11-17T10:00:00-08:00';

export function nowQb(offsetMs = 0): string {
  // QuickBooks style: local time with offset; UTC is fine for the tests.
  return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

export function customerRet(
  id: string,
  name: string,
  opts: { editSequence?: string; created?: string; modified?: string } = {},
): Record<string, unknown> {
  return {
    ListID: id,
    TimeCreated: opts.created ?? T0,
    TimeModified: opts.modified ?? opts.created ?? T0,
    EditSequence: opts.editSequence ?? '1',
    Name: name,
    FullName: name,
    IsActive: 'true',
    Sublevel: '0',
  };
}

export function invoiceRet(
  id: string,
  ref: string,
  opts: { editSequence?: string; created?: string; amount?: string } = {},
): Record<string, unknown> {
  const amount = opts.amount ?? '100.00';
  return {
    TxnID: id,
    TimeCreated: opts.created ?? T0,
    TimeModified: opts.created ?? T0,
    EditSequence: opts.editSequence ?? '1',
    TxnNumber: '5',
    CustomerRef: { ListID: '80000001-1', FullName: 'Acme' },
    TxnDate: '2026-11-17',
    RefNumber: ref,
    Subtotal: amount,
    BalanceRemaining: amount,
    InvoiceLineRet: [{ TxnLineID: `${id}-L1`, Desc: 'Consulting', Amount: amount }],
  };
}

/** Build a request with @qbv/qbxml and assert it is XSD-valid. */
export function validRequest(
  rq: string,
  body: object,
  opts: Parameters<typeof buildRequest>[2] = {},
): string {
  const xml = buildRequest(rq, body, opts);
  const v = validate(xml);
  if (!v.valid) throw new Error(`invalid test request: ${JSON.stringify(v.errors)}`);
  return xml;
}

export async function newCommand(
  db: Db,
  input: Omit<NewCommandInput, 'actorType'> & { actorType?: NewCommandInput['actorType'] },
) {
  return createCommand(db, { actorType: 'user', actorId: 'u-1', ...input });
}

export class CapturedEvents implements EventPublisher {
  readonly events: QbvEvent[] = [];
  async publish(e: QbvEvent): Promise<void> {
    this.events.push(e);
  }
  of<T extends QbvEvent['type']>(type: T): Extract<QbvEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<QbvEvent, { type: T }>[];
  }
  clear(): void {
    this.events.length = 0;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  stepMs = 25,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(stepMs);
  }
  throw new Error('condition not met in time');
}
