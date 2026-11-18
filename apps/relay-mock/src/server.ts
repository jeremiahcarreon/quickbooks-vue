// HTTP front end with the exact contract of the Windows relay (server/):
//   POST /qb/request {qbxml} -> {response, error}
//   GET  /qb/health, POST /qb/restart, GET /qb/errors
// plus /mock/* control endpoints for tests (faults, latency, reset, export).
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import { XMLValidator } from 'fast-xml-parser';
import { validate } from '@qbv/qbxml';
import { type Logger } from '@qbv/config';
import { Engine } from './engine.js';
import { seedSampleCompany, type SeedOptions } from './seed.js';
import { type StoreSnapshot } from './store.js';
import { qbxmlVersion, parseRequestDoc } from './xml.js';

/** What QuickBooks' COM layer says for a document it cannot parse (HRESULT 0x80040400). */
export const QB_PARSE_ERROR =
  'QuickBooks found an error when parsing the provided XML text stream.';

export type FaultMode =
  'disconnected' | 'timeout' | 'error' | 'drop' | 'executeThenTimeout' | 'garbage';

export interface Fault {
  mode: FaultMode;
  /** Requests still affected; 0 = until cleared. */
  remaining: number;
  /** For timeout faults: how long to hold the request before answering 504. */
  delayMs?: number;
  /** For error faults: the error text. */
  message?: string;
}

export interface RelayMockOptions {
  engine?: Engine;
  /** Expected X-Api-Key; empty = no key check (as the relay). */
  apiKey?: string;
  /** Allowed client IPs besides loopback; empty = no IP check. */
  allowedIps?: string[];
  latencyMs?: number;
  latencyJitterMs?: number;
  /** Relay-side request timeout used by timeout faults (default 120s). */
  requestTimeoutMs?: number;
  logger?: Logger;
  /** Persist the store to this JSON file. */
  dataFile?: string;
  /** Seed the sample company if the store is empty. */
  seed?: boolean | SeedOptions;
}

export interface RequestResult {
  status: number;
  body: { response?: string | null; error?: string | null; [k: string]: unknown };
  /** Destroy the connection without answering (drop fault). */
  drop?: boolean;
  /** libxml2 detail for an XSD rejection (sent as X-Mock-Validation-Error). */
  validationError?: string;
}

interface LogEntry {
  at: string;
  requests: string[];
  status: number;
  statusCodes: number[];
  ms: number;
  error?: string;
}

const MAX_ERROR_LOG = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RelayMock {
  readonly engine: Engine;
  readonly server: http.Server;
  apiKey: string;
  allowedIps: string[];
  latencyMs: number;
  latencyJitterMs: number;
  requestTimeoutMs: number;
  faults: Fault[] = [];
  readonly requestLog: LogEntry[] = [];
  private errorLog = '';
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestTime?: Date;
  private lastError: string | null = null;
  private readonly startedAt = Date.now();
  private readonly logger?: Logger;
  private readonly dataFile?: string;
  private saveTimer?: NodeJS.Timeout;
  private savedRevision = -1;
  private readonly sockets = new Set<Socket>();

  constructor(opts: RelayMockOptions = {}) {
    this.engine = opts.engine ?? new Engine();
    this.apiKey = opts.apiKey ?? '';
    this.allowedIps = opts.allowedIps ?? [];
    this.latencyMs = opts.latencyMs ?? 0;
    this.latencyJitterMs = opts.latencyJitterMs ?? 0;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
    this.logger = opts.logger;
    this.dataFile = opts.dataFile;
    if (this.dataFile && existsSync(this.dataFile)) {
      this.engine.store.load(JSON.parse(readFileSync(this.dataFile, 'utf8')) as StoreSnapshot);
      this.logger?.info(
        { file: this.dataFile, objects: this.engine.store.size },
        'loaded company data',
      );
    }
    this.engine.ensureSingletons();
    if (opts.seed && !this.hasUserData()) {
      const seeded = seedSampleCompany(this.engine, typeof opts.seed === 'object' ? opts.seed : {});
      this.logger?.info(seeded, 'seeded sample company');
    }
    this.savedRevision =
      this.dataFile && existsSync(this.dataFile) ? this.engine.store.revision : -1;
    this.server = http.createServer((req, res) => {
      void this.route(req, res);
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  private hasUserData(): boolean {
    return this.engine.store
      .entities()
      .some((e) => !['Host', 'Company', 'Preferences'].includes(e));
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<{ url: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const addr = this.server.address() as AddressInfo;
    const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return { url: `http://${h}:${addr.port}`, port: addr.port };
  }

  async close(): Promise<void> {
    this.flush();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      for (const s of this.sockets) s.destroy();
    });
  }

  // -------------------------------------------------------------------------
  // Persistence

  private scheduleSave(): void {
    if (!this.dataFile || this.engine.store.revision === this.savedRevision) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        this.flush();
      } catch (err) {
        this.logger?.error({ err, file: this.dataFile }, 'could not save company data');
      }
    }, 200);
    this.saveTimer.unref();
  }

  /** Write the store to the data file now (if configured and changed). */
  flush(): void {
    clearTimeout(this.saveTimer);
    if (!this.dataFile || this.engine.store.revision === this.savedRevision) return;
    mkdirSync(path.dirname(path.resolve(this.dataFile)), { recursive: true });
    const tmp = `${this.dataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.engine.store.snapshot()));
    renameSync(tmp, this.dataFile);
    this.savedRevision = this.engine.store.revision;
  }

  // -------------------------------------------------------------------------
  // Error log in the relay's qb-errors.log format.

  private logError(category: string, message: string, requestXml?: string): void {
    let entry = `[${new Date().toISOString()}] [${category}] ${message}\n`;
    if (requestXml) {
      const preview = requestXml.length > 500 ? `${requestXml.slice(0, 500)}...` : requestXml;
      entry += `  Request: ${preview}\n`;
    }
    entry += '\n';
    this.errorLog += entry;
    if (this.errorLog.length > MAX_ERROR_LOG * 2)
      this.errorLog = this.errorLog.slice(-MAX_ERROR_LOG);
  }

  recentErrors(): string {
    return this.errorLog.length > MAX_ERROR_LOG
      ? this.errorLog.slice(-MAX_ERROR_LOG)
      : this.errorLog;
  }

  // -------------------------------------------------------------------------
  // Request processing (one at a time, like QuickBooks)

  private takeFault(): Fault | undefined {
    const f = this.faults[0];
    if (!f) return undefined;
    if (f.remaining > 0 && --f.remaining === 0) this.faults.shift();
    return f;
  }

  /** Process one relay request body (serialized). */
  handleQbxml(qbxml: string): Promise<RequestResult> {
    const run = this.queue.then(() => this.process(qbxml));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async process(qbxml: string): Promise<RequestResult> {
    const started = Date.now();
    const log: LogEntry = {
      at: new Date().toISOString(),
      requests: [],
      status: 200,
      statusCodes: [],
      ms: 0,
    };
    const done = (r: RequestResult): RequestResult => {
      log.status = r.status;
      log.ms = Date.now() - started;
      if (r.body.error) log.error = String(r.body.error);
      this.requestLog.push(log);
      if (this.requestLog.length > 200) this.requestLog.shift();
      this.logger?.info(
        { requests: log.requests, status: log.status, statusCodes: log.statusCodes, ms: log.ms },
        'qbXML request',
      );
      return r;
    };

    const fault = this.takeFault();
    if (fault?.mode === 'disconnected') {
      this.lastError = 'QB not connected';
      return done({ status: 503, body: { error: 'QB not connected' } });
    }
    if (fault?.mode === 'drop') return done({ status: 0, body: {}, drop: true });
    if (fault?.mode === 'timeout') {
      await sleep(fault.delayMs ?? this.requestTimeoutMs);
      const secs = Math.round(this.requestTimeoutMs / 1000);
      this.logError('TIMEOUT', `Request timed out after ${secs}s`, qbxml);
      return done({
        status: 504,
        body: { error: `QB request timed out (${secs}s) — worker restarted` },
      });
    }
    if (fault?.mode === 'error') {
      const msg = fault.message ?? 'Exception from HRESULT: 0x80040408 Could not start QuickBooks.';
      this.logError('COM_EXCEPTION', msg, qbxml);
      this.lastError = msg;
      return done({ status: 502, body: { error: msg } });
    }

    const latency =
      this.latencyMs + (this.latencyJitterMs ? Math.random() * this.latencyJitterMs : 0);
    if (latency > 0) await sleep(latency);
    this.lastRequestTime = new Date();

    // Well-formedness first, as the relay does before handing the text to QuickBooks.
    const wf = XMLValidator.validate(qbxml);
    if (wf !== true) {
      const msg = `Malformed XML rejected before sending to QB: Line ${wf.err.line}, Position ${wf.err.col}: ${wf.err.msg}`;
      this.logger?.warn({ error: msg }, 'malformed qbXML rejected');
      this.logError('XML_VALIDATION', msg, qbxml);
      return done({ status: 502, body: { error: msg } });
    }
    // Then the schema: QuickBooks rejects anything that does not validate.
    const r = validate(qbxml);
    const version = qbxmlVersion(qbxml);
    if (!r.valid || !version) {
      const detail = !version
        ? 'missing <?qbxml version="..."?> processing instruction'
        : r.errors
            .slice(0, 5)
            .map((e) => `line ${e.line}: ${e.message}`)
            .join('; ');
      this.logger?.warn({ errors: r.errors.slice(0, 5) }, 'qbXML failed XSD validation');
      this.logError('QB_PARSE_REJECT', `HRESULT 0x80040400: ${QB_PARSE_ERROR} (${detail})`, qbxml);
      return done({ status: 502, body: { error: QB_PARSE_ERROR }, validationError: detail });
    }

    const doc = parseRequestDoc(qbxml);
    log.requests = doc.requests.map((q) => q.name);
    let xml: string;
    try {
      const out = this.engine.processDocument(doc);
      xml = out.xml;
      log.statusCodes = out.outcomes.map((o) => o.statusCode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error({ err }, 'relay mock failed to process a request');
      this.logError('REQUEST_FAILED', msg, qbxml);
      return done({ status: 502, body: { error: msg } });
    }
    this.lastError = null;
    this.scheduleSave();
    if (fault?.mode === 'executeThenTimeout') {
      const secs = Math.round(this.requestTimeoutMs / 1000);
      return done({
        status: 504,
        body: { error: `QB request timed out (${secs}s) — worker restarted` },
      });
    }
    if (fault?.mode === 'garbage')
      return done({
        status: 200,
        body: { response: xml.slice(0, Math.floor(xml.length / 2)), error: null },
      });
    return done({ status: 200, body: { response: xml, error: null } });
  }

  // -------------------------------------------------------------------------
  // HTTP

  private clientIp(req: IncomingMessage): string {
    const ip = req.socket.remoteAddress ?? '';
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const ip = this.clientIp(req);
      if (
        this.allowedIps.length &&
        !this.allowedIps.includes(ip) &&
        ip !== '::1' &&
        ip !== '127.0.0.1'
      ) {
        return json(res, 403, { error: 'IP not allowed' });
      }
      const key = req.headers['x-api-key'];
      if (this.apiKey && key !== this.apiKey) return json(res, 401, { error: 'Invalid API key' });

      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;
      const m = req.method ?? 'GET';

      if (m === 'GET' && p === '/qb/health') {
        const disconnected = this.faults.some((f) => f.mode === 'disconnected');
        return json(res, 200, {
          connected: !disconnected,
          lastError: disconnected ? 'QB not connected' : this.lastError,
          lastRequestTime: this.lastRequestTime ? this.lastRequestTime.toISOString() : null,
          uptime: (Date.now() - this.startedAt) / 1000,
        });
      }
      if (m === 'POST' && p === '/qb/request') {
        const raw = await readBody(req);
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return json(res, 500, { error: 'Internal server error' });
        }
        const k = Object.keys(payload ?? {}).find((x) => x.toLowerCase() === 'qbxml');
        const qbxml = k ? payload[k] : undefined;
        if (typeof qbxml !== 'string' || !qbxml.trim())
          return json(res, 400, { error: "Missing 'qbxml' field in request body" });
        const result = await this.handleQbxml(qbxml);
        if (result.drop) {
          req.socket.destroy();
          return;
        }
        if (result.validationError)
          res.setHeader(
            'X-Mock-Validation-Error',
            result.validationError.replace(/[^\x20-\x7e]+/g, ' ').slice(0, 1000),
          );
        return json(res, result.status, result.body);
      }
      if (m === 'POST' && p === '/qb/restart') {
        this.faults = this.faults.filter((f) => f.mode !== 'disconnected');
        this.lastError = null;
        this.logError('MANUAL_RESTART', 'Worker restart requested');
        return json(res, 200, { restarted: true });
      }
      if (m === 'GET' && p === '/qb/errors') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(this.recentErrors());
        return;
      }
      if (p.startsWith('/mock/')) return await this.control(m, p, req, res);
      return json(res, 404, {
        error:
          'Not found. Routes: GET /qb/health, POST /qb/request, POST /qb/restart, GET /qb/errors',
      });
    } catch (err) {
      this.logger?.error({ err }, 'unhandled error in request handler');
      if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
    }
  }

  private async control(
    m: string,
    p: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = async () => {
      const raw = await readBody(req);
      return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    };
    if (m === 'GET' && p === '/mock/state') return json(res, 200, this.state());
    if (m === 'POST' && p === '/mock/reset') {
      const b = await body();
      await this.serialized(() => {
        this.engine.store.clear();
        this.engine.iterators.clear();
        this.engine.ensureSingletons();
        if (b.seed)
          seedSampleCompany(this.engine, {
            anchor: typeof b.anchor === 'string' ? b.anchor : undefined,
          });
        this.scheduleSave();
      });
      return json(res, 200, this.state());
    }
    if (p === '/mock/faults') {
      if (m === 'GET') return json(res, 200, { faults: this.faults });
      if (m === 'DELETE') {
        this.faults = [];
        return json(res, 200, { faults: [] });
      }
      if (m === 'POST') {
        const b = await body();
        const modes: FaultMode[] = [
          'disconnected',
          'timeout',
          'error',
          'drop',
          'executeThenTimeout',
          'garbage',
        ];
        if (!modes.includes(b.mode as FaultMode))
          return json(res, 400, { error: `mode must be one of ${modes.join(', ')}` });
        const fault: Fault = {
          mode: b.mode as FaultMode,
          remaining: typeof b.count === 'number' && b.count >= 0 ? b.count : 1,
          delayMs: typeof b.delayMs === 'number' ? b.delayMs : undefined,
          message: typeof b.message === 'string' ? b.message : undefined,
        };
        this.faults.push(fault);
        return json(res, 200, { faults: this.faults });
      }
    }
    if ((m === 'PUT' || m === 'POST') && p === '/mock/latency') {
      const b = await body();
      if (typeof b.ms === 'number' && b.ms >= 0) this.latencyMs = b.ms;
      if (typeof b.jitterMs === 'number' && b.jitterMs >= 0) this.latencyJitterMs = b.jitterMs;
      return json(res, 200, { latencyMs: this.latencyMs, latencyJitterMs: this.latencyJitterMs });
    }
    if ((m === 'PUT' || m === 'POST') && p === '/mock/clock') {
      const b = await body();
      if (b.now === null || b.now === undefined) {
        this.engine.clock = { now: () => new Date() };
      } else {
        const fixed = new Date(String(b.now));
        if (Number.isNaN(fixed.getTime()))
          return json(res, 400, { error: 'now must be an ISO date-time or null' });
        const offset = fixed.getTime() - Date.now();
        this.engine.clock = { now: () => new Date(Date.now() + offset) };
      }
      return json(res, 200, { now: this.engine.clock.now().toISOString() });
    }
    if (m === 'GET' && p === '/mock/requests') return json(res, 200, { requests: this.requestLog });
    if (m === 'GET' && p === '/mock/export') return json(res, 200, this.engine.store.snapshot());
    if (m === 'POST' && p === '/mock/import') {
      const b = await body();
      await this.serialized(() => {
        this.engine.store.load(b as unknown as StoreSnapshot);
        this.engine.iterators.clear();
        this.engine.ensureSingletons();
        this.scheduleSave();
      });
      return json(res, 200, this.state());
    }
    return json(res, 404, { error: 'Not found' });
  }

  private serialized<T>(fn: () => T): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  state(): Record<string, unknown> {
    const objects: Record<string, number> = {};
    for (const e of this.engine.store.entities().sort())
      objects[e] = this.engine.store.all(e).length;
    return {
      objects,
      total: this.engine.store.size,
      deleted: this.engine.store.deleted.length,
      iterators: this.engine.iterators.size,
      revision: this.engine.store.revision,
      faults: this.faults,
      latencyMs: this.latencyMs,
      now: this.engine.clock.now().toISOString(),
    };
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
}

function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
