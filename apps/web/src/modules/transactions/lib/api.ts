/**
 * Thin, tolerant adapters over the HTTP API (DESIGN section 6.6) used by the
 * transaction forms, centers and home dashboard.
 */
import { api, ApiError, type QueryParams } from '@/api/client';
import { REF_SOURCES, rowToRef, type RefSource } from './refs';
import type { ObjectList, ObjectRow, RefSourceName, RefValue } from './types';

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function s(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

/** Normalise one read-model row (`{type, qb_id, name, ..., data}` or a bare Ret). */
export function normalizeRow(raw: unknown, fallbackType = ''): ObjectRow {
  const r = isObj(raw) ? raw : {};
  const data = isObj(r.data) ? r.data : r;
  return {
    type: s(r.type) ?? fallbackType,
    id: s(r.qb_id) ?? s(r.qbId) ?? s(r.id) ?? s(data.TxnID) ?? s(data.ListID) ?? '',
    name: s(r.name) ?? s(data.FullName) ?? s(data.Name),
    refNumber: s(r.ref_number) ?? s(r.refNumber) ?? s(data.RefNumber),
    txnDate: s(r.txn_date) ?? s(r.txnDate) ?? s(data.TxnDate),
    amount: s(r.amount) ?? undefined,
    editSequence: s(r.edit_sequence) ?? s(r.editSequence) ?? s(data.EditSequence),
    timeModified: s(r.time_modified) ?? s(r.timeModified) ?? s(data.TimeModified),
    data,
  };
}

export function normalizeList(raw: unknown, type: string): ObjectList {
  let items: unknown[] = [];
  let total: number | undefined;
  let page = 1;
  let pageSize = 0;
  if (Array.isArray(raw)) items = raw;
  else if (isObj(raw)) {
    const arr = raw.items ?? raw.rows ?? raw.data ?? raw.results;
    if (Array.isArray(arr)) items = arr;
    total = typeof raw.total === 'number' ? raw.total : Number(raw.total ?? NaN);
    page = Number(raw.page ?? 1) || 1;
    pageSize = Number(raw.pageSize ?? raw.page_size ?? items.length) || items.length;
  }
  return {
    items: items.map((i) => normalizeRow(i, type)),
    total: Number.isFinite(total) ? (total as number) : items.length,
    page,
    pageSize,
  };
}

export interface ListParams {
  q?: string;
  filter?: Record<string, string>;
  sort?: string;
  page?: number;
  pageSize?: number;
  includeInactive?: boolean;
}

export async function listObjects(
  type: string,
  params: ListParams = {},
  signal?: AbortSignal,
): Promise<ObjectList> {
  const query: QueryParams = {
    q: params.q,
    sort: params.sort,
    page: params.page,
    pageSize: params.pageSize,
    includeInactive: params.includeInactive ? true : undefined,
  };
  if (params.filter) query.filter = params.filter;
  const raw = await api.get(`/objects/${encodeURIComponent(type)}`, { query, signal });
  return normalizeList(raw, type);
}

/** Fetch every page up to `limit` rows. `truncated` is true when more exist. */
export async function listAll(
  type: string,
  params: Omit<ListParams, 'page'> = {},
  limit = 2000,
  signal?: AbortSignal,
): Promise<{ items: ObjectRow[]; total: number; truncated: boolean }> {
  const pageSize = Math.min(params.pageSize ?? 500, 500);
  const items: ObjectRow[] = [];
  let total = 0;
  for (let page = 1; items.length < limit; page++) {
    const res = await listObjects(type, { ...params, page, pageSize }, signal);
    total = res.total;
    items.push(...res.items);
    if (res.items.length < pageSize || items.length >= total) break;
  }
  return { items: items.slice(0, limit), total, truncated: total > limit };
}

export async function getObject(type: string, id: string): Promise<ObjectRow> {
  const raw = await api.get(`/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
  const inner = isObj(raw) && isObj(raw.item) ? raw.item : raw;
  return normalizeRow(inner, type);
}

// ---------------------------------------------------------------------------
// Commands

export type CommandStatus = 'queued' | 'sending' | 'succeeded' | 'failed' | 'conflict' | 'rejected';

export interface CommandView {
  id: string;
  status: CommandStatus;
  statusCode?: number;
  statusMessage?: string;
  result?: unknown;
  objectId?: string;
}

export const TERMINAL: readonly CommandStatus[] = ['succeeded', 'failed', 'conflict', 'rejected'];

export function normalizeCommand(raw: unknown, fallbackId = ''): CommandView {
  const r = isObj(raw) ? (isObj(raw.command) ? raw.command : raw) : {};
  const code = r.statusCode ?? r.status_code;
  return {
    id: s(r.id) ?? s(r.commandId) ?? fallbackId,
    status: (s(r.status) as CommandStatus | undefined) ?? 'queued',
    statusCode: code === undefined || code === null ? undefined : Number(code),
    statusMessage: s(r.statusMessage) ?? s(r.status_message),
    result: r.result,
    objectId: s(r.objectId) ?? s(r.object_id),
  };
}

export interface SubmitResult {
  commandId: string;
  /** Present when the API answered synchronously. */
  command?: CommandView;
}

/** POST (add) or PATCH (mod) an object. The API replies 202 {commandId}. */
export async function submitObject(type: string, body: Json, id?: string): Promise<SubmitResult> {
  const path = id
    ? `/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
    : `/objects/${encodeURIComponent(type)}`;
  const raw = id ? await api.patch(path, body) : await api.post(path, body);
  const r = isObj(raw) ? raw : {};
  const commandId = s(r.commandId) ?? s(r.id) ?? (isObj(r.command) ? s(r.command.id) : undefined);
  if (!commandId)
    throw new ApiError(500, 'bad_response', 'The server did not return a command id.');
  const hasStatus = typeof r.status === 'string' || isObj(r.command);
  return { commandId, command: hasStatus ? normalizeCommand(r, commandId) : undefined };
}

export async function getCommand(id: string): Promise<CommandView> {
  return normalizeCommand(await api.get(`/commands/${encodeURIComponent(id)}`), id);
}

/** Find the first TxnID/ListID inside a command result (the created object). */
export function resultObjectId(result: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | undefined => {
    if (!v || typeof v !== 'object' || seen.has(v)) return undefined;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) {
        const id = walk(x);
        if (id) return id;
      }
      return undefined;
    }
    const o = v as Json;
    const direct = s(o.TxnID) ?? s(o.ListID);
    if (direct) return direct;
    for (const k of Object.keys(o)) {
      const id = walk(o[k]);
      if (id) return id;
    }
    return undefined;
  };
  return walk(result);
}

/** The refreshed object a conflict result carries (`result.current`). */
export function conflictCurrent(result: unknown): Json | undefined {
  if (!isObj(result)) return undefined;
  const cur = result.current;
  if (isObj(cur)) return isObj(cur.data) ? cur.data : cur;
  return undefined;
}

// ---------------------------------------------------------------------------
// Meta: field definitions from the catalog (GET /meta/entities/:type)

export interface MetaField {
  name: string;
  kind?: 'simple' | 'complex';
  type?: string;
  minOccurs?: number;
  maxOccurs?: number | 'unbounded';
  maxLength?: number;
  enum?: string[];
  children?: string;
}

export interface MetaObject {
  name: string;
  fields: MetaField[];
}

export type MetaDefs = Map<string, MetaObject>;

/**
 * Collect every ObjectDef-shaped value (`{name, fields: [...]}`) found
 * anywhere in a meta response, keyed by name. This keeps the forms working
 * whatever envelope the endpoint uses (`{add, mod}`, `{objects: {...}}`, ...).
 */
export function collectObjectDefs(raw: unknown, into: MetaDefs = new Map()): MetaDefs {
  const seen = new Set<unknown>();
  const walk = (v: unknown, key?: string) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x));
      return;
    }
    const o = v as Json;
    if (Array.isArray(o.fields) && o.fields.every((f) => isObj(f) && typeof f.name === 'string')) {
      const name = s(o.name) ?? key;
      if (name && !into.has(name)) into.set(name, { name, fields: o.fields as MetaField[] });
    }
    for (const [k, x] of Object.entries(o)) walk(x, k);
  };
  walk(raw);
  return into;
}

const metaCache = new Map<string, Promise<MetaDefs>>();

/** Field definitions for an entity; resolves to an empty map if meta is unavailable. */
export function getEntityMeta(type: string): Promise<MetaDefs> {
  let p = metaCache.get(type);
  if (!p) {
    p = api
      .get(`/meta/entities/${encodeURIComponent(type)}`)
      .then((raw) => collectObjectDefs(raw))
      .catch(() => {
        metaCache.delete(type);
        return new Map() as MetaDefs;
      });
    metaCache.set(type, p);
  }
  return p;
}

export function clearMetaCache(): void {
  metaCache.clear();
}

// ---------------------------------------------------------------------------
// Ref search

const searchCache = new Map<string, { at: number; value: RefValue[] }>();
const SEARCH_TTL = 30_000;

/** Search one or more read-model types for picker options (merged, sorted by name). */
export async function searchRefs(
  source: RefSourceName | RefSource,
  q: string,
  opts: { pageSize?: number; signal?: AbortSignal } = {},
): Promise<RefValue[]> {
  const src = typeof source === 'string' ? REF_SOURCES[source] : source;
  const key = JSON.stringify([src.types, src.filter, q.trim().toLowerCase()]);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.value;
  const pageSize = opts.pageSize ?? (src.types.length > 1 ? 15 : 30);
  const results = await Promise.allSettled(
    src.types.map((type) =>
      listObjects(
        type,
        { q: q.trim() || undefined, filter: src.filter, sort: 'name', pageSize },
        opts.signal,
      ),
    ),
  );
  const ok = results.filter(
    (r): r is PromiseFulfilledResult<ObjectList> => r.status === 'fulfilled',
  );
  if (ok.length === 0 && results.length > 0) {
    const first = results[0] as PromiseRejectedResult;
    throw first.reason;
  }
  const value = ok
    .flatMap((r) => r.value.items)
    .map(rowToRef)
    .sort((a, b) => (a.FullName ?? '').localeCompare(b.FullName ?? ''));
  searchCache.set(key, { at: Date.now(), value });
  return value;
}

export function clearSearchCache(): void {
  searchCache.clear();
}

// ---------------------------------------------------------------------------
// Health

export interface HealthView {
  ok: boolean;
  parts: Record<string, { ok: boolean; detail?: string }>;
  raw: unknown;
}

function partOk(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['ok', 'up', 'healthy', 'connected', 'true'].includes(v);
  if (isObj(v)) {
    if ('ok' in v) return partOk(v.ok);
    if ('status' in v) return partOk(v.status);
    if ('connected' in v) return partOk(v.connected);
    if ('healthy' in v) return partOk(v.healthy);
  }
  return false;
}

export function normalizeHealth(raw: unknown): HealthView {
  const r = isObj(raw) ? raw : {};
  const src = isObj(r.checks) ? r.checks : isObj(r.services) ? r.services : r;
  const parts: HealthView['parts'] = {};
  for (const name of ['api', 'db', 'database', 'redis', 'relay', 'quickbooks', 'worker']) {
    if (name in src) {
      const v = src[name];
      parts[name === 'database' ? 'db' : name] = {
        ok: partOk(v),
        detail: isObj(v) ? (s(v.message) ?? s(v.error) ?? s(v.detail)) : undefined,
      };
    }
  }
  const overall = 'ok' in r ? partOk(r.ok) : 'status' in r ? partOk(r.status) : undefined;
  return {
    ok: overall ?? Object.values(parts).every((p) => p.ok),
    parts,
    raw,
  };
}

export async function getHealth(): Promise<HealthView> {
  try {
    return normalizeHealth(await api.get('/health'));
  } catch (err) {
    // /health answers 503 with the same body when something is down.
    if (err instanceof ApiError && err.details !== undefined) return normalizeHealth(err.details);
    throw err;
  }
}

/**
 * Fill in `data` for a ref that came from a Ret (which only has ListID and
 * FullName), e.g. to learn a sales tax item's rate or a term's due days.
 */
export async function hydrateRef(
  source: RefSourceName,
  value: RefValue | null | undefined,
): Promise<RefValue | null> {
  if (!value || value.data) return value ?? null;
  const types = REF_SOURCES[source].types;
  if (value.ListID) {
    for (const type of types) {
      try {
        const row = await getObject(type, value.ListID);
        if (row.id) return { ...rowToRef(row), FullName: value.FullName ?? rowToRef(row).FullName };
      } catch {
        // try the next type
      }
    }
    return value;
  }
  if (value.FullName) {
    const hits = await searchRefs(source, value.FullName).catch(() => [] as RefValue[]);
    const exact = hits.find((h) => h.FullName?.toLowerCase() === value.FullName!.toLowerCase());
    return exact ?? value;
  }
  return value;
}
