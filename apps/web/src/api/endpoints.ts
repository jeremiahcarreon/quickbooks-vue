/**
 * Typed wrappers for the HTTP API (DESIGN 6.6). Every response goes through a
 * normaliser so the rest of the app sees one shape.
 */
import { api, ApiError, request, type QueryParams } from './client';
import {
  csrfFrom,
  toAdminUser,
  toApiToken,
  toCommand,
  toCommandRef,
  toCurrentUser,
  toEntityList,
  toEntityMeta,
  toHealth,
  toObjectDef,
  toObjectMap,
  toPage,
  toQbObject,
  toRole,
  toSyncState,
  unwrapList,
  isObj,
} from './normalize';
import type {
  AdminUser,
  ApiToken,
  Command,
  CommandStatus,
  CurrentUser,
  EntityDef,
  EntityMeta,
  HealthStatus,
  ObjectDef,
  Page,
  QbObject,
  Role,
  SyncState,
} from './types';

const enc = encodeURIComponent;

// ---------------------------------------------------------------- auth

export interface Session {
  user: CurrentUser | null;
  csrfToken: string | null;
}

export const authApi = {
  async login(email: string, password: string): Promise<Session> {
    const res = await api.post('/auth/login', { email, password });
    return { user: toCurrentUser(res), csrfToken: csrfFrom(res) };
  },
  async logout(): Promise<void> {
    await api.post('/auth/logout');
  },
  async me(): Promise<Session> {
    const res = await api.get('/auth/me');
    return { user: toCurrentUser(res), csrfToken: csrfFrom(res) };
  },
};

// ---------------------------------------------------------------- meta

export const metaApi = {
  async entities(): Promise<EntityDef[]> {
    return toEntityList(await api.get('/meta/entities'));
  },
  async entity(type: string): Promise<EntityMeta> {
    const meta = toEntityMeta(await api.get(`/meta/entities/${enc(type)}`));
    if (!meta) throw new ApiError(500, 'bad_meta', `Unexpected metadata for ${type}`);
    return meta;
  },
  /** Fallback for an ObjectDef the entity metadata did not include. */
  async object(name: string): Promise<ObjectDef | null> {
    return (await metaApi.objectClosure(name))[name] ?? null;
  },
  /**
   * GET /meta/objects/:name: the object and every object it uses
   * (`{ root, request, objects }`). Also accepts a bare ObjectDef or
   * `{ object }`. Empty when the name is unknown (404).
   */
  async objectClosure(name: string): Promise<Record<string, ObjectDef>> {
    let res: unknown;
    try {
      res = await api.get(`/meta/objects/${enc(name)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return {};
      throw err;
    }
    if (isObj(res) && isObj(res.objects)) return toObjectMap(res.objects);
    const d = toObjectDef(isObj(res) && isObj(res.object) ? res.object : res, name);
    return d ? { [d.name || name]: d } : {};
  },
};

// ---------------------------------------------------------------- objects

export interface ListParams {
  q?: string;
  /** `{ TxnDate: 'gte:2024-01-01' }` -> `filter[TxnDate]=gte:2024-01-01`. */
  filter?: Record<string, string>;
  /** `name,-txn_date`. */
  sort?: string;
  page?: number;
  pageSize?: number;
  includeInactive?: boolean;
}

export const objectsApi = {
  async list(type: string, params: ListParams = {}, signal?: AbortSignal): Promise<Page<QbObject>> {
    const query: QueryParams = {
      q: params.q,
      sort: params.sort,
      page: params.page,
      pageSize: params.pageSize,
      includeInactive: params.includeInactive ? 'true' : undefined,
      filter: params.filter,
    };
    const res = await api.get(`/objects/${enc(type)}`, { query, signal });
    return toPage(res, (x) => toQbObject(x, type));
  },
  async get(type: string, id: string): Promise<QbObject> {
    const res = await api.get(`/objects/${enc(type)}/${enc(id)}`);
    return toQbObject(isObj(res) && isObj(res.object) ? res.object : res, type);
  },
  async add(
    type: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string; status: CommandStatus }> {
    return toCommandRef(await api.post(`/objects/${enc(type)}`, body));
  },
  async mod(
    type: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string; status: CommandStatus }> {
    return toCommandRef(await api.patch(`/objects/${enc(type)}/${enc(id)}`, body));
  },
  async del(type: string, id: string): Promise<{ id: string; status: CommandStatus }> {
    return toCommandRef(await api.del(`/objects/${enc(type)}/${enc(id)}`));
  },
  async void(type: string, id: string): Promise<{ id: string; status: CommandStatus }> {
    return toCommandRef(await api.post(`/objects/${enc(type)}/${enc(id)}/void`));
  },
  /**
   * Live query: QuickBooks answers directly (the read model is not involved).
   * `body` is the query request content in qbXML element names.
   */
  async live(type: string, body: Record<string, unknown>): Promise<LiveQueryResult> {
    return toLiveResult(await api.post(`/objects/${enc(type)}/live`, body));
  },
  /** Merge this list record into `into` (ListMergeRq). */
  async merge(
    type: string,
    id: string,
    into: string,
    sameShipAddrOk?: boolean,
  ): Promise<{ id: string; status: CommandStatus }> {
    return toCommandRef(
      await api.post(`/objects/${enc(type)}/${enc(id)}/merge`, {
        into,
        ...(sameShipAddrOk !== undefined ? { sameShipAddrOk } : {}),
      }),
    );
  },
  /** Mark a transaction Cleared / NotCleared / Pending (ClearedStatusModRq). */
  async clearedStatus(
    type: string,
    id: string,
    status: 'Cleared' | 'NotCleared' | 'Pending',
  ): Promise<{ id: string; status: CommandStatus }> {
    return toCommandRef(
      await api.post(`/objects/${enc(type)}/${enc(id)}/cleared-status`, { status }),
    );
  },
};

// ---------------------------------------------------------------- live queries and SDK actions

export interface ParsedResponse {
  name: string;
  statusCode: number;
  statusSeverity: string;
  statusMessage: string;
  rets: Record<string, unknown>[];
  retNames: string[];
}

export interface LiveQueryResult {
  commandId: string | null;
  /** True while QuickBooks has not answered yet (202). */
  pending: boolean;
  items: Record<string, unknown>[];
  responses: ParsedResponse[];
}

function toResponses(v: unknown): ParsedResponse[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((r) => ({
    name: typeof r.name === 'string' ? r.name : '',
    statusCode: typeof r.statusCode === 'number' ? r.statusCode : Number(r.statusCode ?? 0),
    statusSeverity: typeof r.statusSeverity === 'string' ? r.statusSeverity : '',
    statusMessage: typeof r.statusMessage === 'string' ? r.statusMessage : '',
    rets: Array.isArray(r.rets) ? r.rets.filter(isObj) : [],
    retNames: Array.isArray(r.retNames) ? r.retNames.map(String) : [],
  }));
}

function toLiveResult(res: unknown): LiveQueryResult {
  const o = isObj(res) ? res : {};
  const responses = toResponses(o.responses);
  return {
    commandId: typeof o.commandId === 'string' ? o.commandId : null,
    pending: !Array.isArray(o.responses),
    items: Array.isArray(o.items) ? o.items.filter(isObj) : (responses[0]?.rets ?? []),
    responses,
  };
}

export interface ActionDef {
  name: string;
  op: string;
  entity: string | null;
  permissions: string[];
  allowed: boolean;
}

export const actionsApi = {
  /** SDK requests that are not an entity operation (GET /actions). */
  async list(): Promise<ActionDef[]> {
    const res = await api.get('/actions');
    const list = isObj(res) && Array.isArray(res.actions) ? res.actions : [];
    return list.filter(isObj).map((a) => ({
      name: String(a.name),
      op: String(a.op ?? ''),
      entity: typeof a.entity === 'string' ? a.entity : null,
      permissions: Array.isArray(a.permissions) ? a.permissions.map(String) : [],
      allowed: a.allowed === true,
    }));
  },
  /** Send one action and wait for QuickBooks (`body` in qbXML element names). */
  async run(name: string, body: Record<string, unknown>): Promise<LiveQueryResult> {
    return toLiveResult(await api.post(`/actions/${enc(name)}`, body, { query: { wait: 'true' } }));
  },
};

// ---------------------------------------------------------------- commands

export const commandsApi = {
  async get(id: string): Promise<Command> {
    return toCommand(await api.get(`/commands/${enc(id)}`));
  },
  /**
   * Newest first. The API pages by keyset: `limit` rows `before` a command id,
   * answering `{ items, nextBefore }`; `pageSize`/`cursor` are accepted as aliases.
   */
  async list(
    params: {
      status?: string;
      type?: string;
      kind?: string;
      pageSize?: number;
      cursor?: string;
      mine?: boolean;
    } = {},
  ): Promise<{ items: Command[]; next: string | null; total: number | null }> {
    const res = await api.get('/commands', {
      query: {
        status: params.status,
        kind: params.kind,
        objectType: params.type,
        limit: params.pageSize,
        before: params.cursor,
        mine: params.mine ? 'true' : undefined,
      },
    });
    const items = unwrapList(res, 'commands').map(toCommand);
    const o = isObj(res) ? res : {};
    const nextKey = ['nextBefore', 'next', 'nextCursor'].find((k) => typeof o[k] === 'string');
    const next = nextKey ? (o[nextKey] as string) : null;
    return { items, next, total: typeof o.total === 'number' ? o.total : null };
  },
};

// ---------------------------------------------------------------- raw qbXML

export interface QbxmlIssue {
  line: number | null;
  column: number | null;
  message: string;
  path?: string;
}

export interface QbxmlResult {
  commandId: string | null;
  status: string | null;
  response: string | null;
  body: unknown;
}

/** libxml2 errors from a 400 response: `details` may be the list or `{ errors }`. */
export function qbxmlIssues(details: unknown): QbxmlIssue[] {
  const list = Array.isArray(details)
    ? details
    : isObj(details) && Array.isArray(details.errors)
      ? details.errors
      : [];
  return list.map((e) => {
    const o = isObj(e) ? e : { message: String(e) };
    return {
      line: typeof o.line === 'number' ? o.line : null,
      column: typeof o.column === 'number' ? o.column : null,
      message: typeof o.message === 'string' ? o.message : JSON.stringify(o),
      ...(typeof o.path === 'string' ? { path: o.path } : {}),
    };
  });
}

function toQbxmlResult(res: unknown): QbxmlResult {
  if (typeof res === 'string') return { commandId: null, status: null, response: res, body: res };
  const o = isObj(res) ? res : {};
  const response =
    typeof o.response === 'string'
      ? o.response
      : typeof o.responseXml === 'string'
        ? o.responseXml
        : typeof o.response_xml === 'string'
          ? o.response_xml
          : null;
  const cmd = toCommandRef(res);
  return {
    commandId: cmd.id || null,
    status: typeof o.status === 'string' ? o.status : null,
    response,
    body: res,
  };
}

export const qbxmlApi = {
  /**
   * Send raw qbXML. The server validates against the XSD and answers 400 with
   * the libxml2 errors when it is invalid. Sent as application/xml; if the API
   * only takes JSON (415) it is resent as `{ qbxml }`.
   */
  async send(xml: string, opts: { wait?: boolean } = {}): Promise<QbxmlResult> {
    const query = opts.wait === false ? {} : { wait: 'true' };
    try {
      return toQbxmlResult(
        await request('POST', '/qbxml', {
          body: xml,
          query,
          headers: { 'Content-Type': 'application/xml' },
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 415) {
        return toQbxmlResult(await request('POST', '/qbxml', { body: { qbxml: xml }, query }));
      }
      throw err;
    }
  },
  /**
   * Server-side XSD check without sending. Returns null when the API has no
   * validate endpoint (the send itself still validates).
   */
  async validate(
    xml: string,
    signal?: AbortSignal,
  ): Promise<{ valid: boolean; errors: QbxmlIssue[] } | null> {
    try {
      const res = await request('POST', '/qbxml/validate', {
        body: xml,
        headers: { 'Content-Type': 'application/xml' },
        signal,
      });
      const o = isObj(res) ? res : {};
      const errors = qbxmlIssues(o.errors ?? []);
      return { valid: o.valid === true || (o.valid === undefined && errors.length === 0), errors };
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        return { valid: false, errors: qbxmlIssues(err.details) };
      }
      if (err instanceof ApiError && [404, 405, 415, 501].includes(err.status)) return null;
      throw err;
    }
  },
};

// ---------------------------------------------------------------- admin

export interface UserInput {
  email?: string;
  displayName?: string;
  password?: string;
  isActive?: boolean;
  roles?: string[];
}
export interface RoleInput {
  name?: string;
  description?: string;
  permissions?: string[];
}
export interface TokenInput {
  name: string;
  permissions: string[];
  expiresAt?: string | null;
}

export const adminApi = {
  async users(): Promise<AdminUser[]> {
    return unwrapList(await api.get('/admin/users'), 'users').map(toAdminUser);
  },
  async createUser(input: UserInput): Promise<AdminUser> {
    return toAdminUser(await api.post('/admin/users', input));
  },
  async updateUser(id: string, input: UserInput): Promise<AdminUser> {
    return toAdminUser(await api.patch(`/admin/users/${enc(id)}`, input));
  },
  async roles(): Promise<Role[]> {
    return unwrapList(await api.get('/admin/roles'), 'roles').map(toRole);
  },
  async createRole(input: RoleInput): Promise<Role> {
    return toRole(await api.post('/admin/roles', input));
  },
  async updateRole(id: string, input: RoleInput): Promise<Role> {
    return toRole(await api.patch(`/admin/roles/${enc(id)}`, input));
  },
  async tokens(): Promise<ApiToken[]> {
    return unwrapList(await api.get('/admin/tokens'), 'tokens').map(toApiToken);
  },
  /** The plain token is only in this response. */
  async createToken(input: TokenInput): Promise<{ token: string; apiToken: ApiToken }> {
    const res = await api.post('/admin/tokens', input);
    const o = isObj(res) ? res : {};
    const token =
      typeof o.token === 'string' ? o.token : typeof o.secret === 'string' ? o.secret : '';
    return { token, apiToken: toApiToken(isObj(o.apiToken) ? o.apiToken : res) };
  },
  async revokeToken(id: string): Promise<void> {
    try {
      await api.patch(`/admin/tokens/${enc(id)}`, { revoked: true });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
        await api.del(`/admin/tokens/${enc(id)}`);
        return;
      }
      throw err;
    }
  },
  async sync(): Promise<SyncState[]> {
    return unwrapList(await api.get('/admin/sync'), 'types', 'states').map(toSyncState);
  },
  async triggerSync(
    type: string,
    opts: { full?: boolean; mode?: 'incremental' | 'full' | 'reconcile' } = {},
  ): Promise<void> {
    const mode = opts.mode ?? (opts.full ? 'full' : 'incremental');
    await api.post(`/admin/sync/${enc(type)}`, { mode });
  },
};

export async function fetchHealth(): Promise<HealthStatus> {
  try {
    return toHealth(await api.get('/health'));
  } catch (err) {
    // 503 still carries the component breakdown.
    if (err instanceof ApiError && err.status === 503) {
      return { ...toHealth(err.details ?? {}), ok: false };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cross-type search (spotlight)

export interface SearchParams {
  q?: string;
  /** Limit hits to these types; every group still reports its total. */
  types?: string[];
  /** Transaction date range, YYYY-MM-DD. */
  from?: string;
  to?: string;
  /** Customer/vendor/employee ListID (a customer includes its jobs). */
  entity?: string;
  amountMin?: string;
  amountMax?: string;
  includeInactive?: boolean;
  perType?: number;
}

export interface SearchHit {
  type: string;
  qbId: string;
  name: string | null;
  refNumber: string | null;
  txnDate: string | null;
  amount: string | null;
  isActive: boolean | null;
  entityRefId: string | null;
  entityName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  memo: string | null;
}

export interface SearchGroup {
  type: string;
  category: 'list' | 'txn' | 'other';
  total: number;
  items: SearchHit[];
}

export const searchApi = {
  async search(params: SearchParams, signal?: AbortSignal): Promise<SearchGroup[]> {
    const query: QueryParams = {
      q: params.q || undefined,
      types: params.types?.length ? params.types.join(',') : undefined,
      from: params.from || undefined,
      to: params.to || undefined,
      entity: params.entity || undefined,
      amountMin: params.amountMin || undefined,
      amountMax: params.amountMax || undefined,
      includeInactive: params.includeInactive ? 'true' : undefined,
      perType: params.perType,
    };
    const res = await api.get<{ groups?: SearchGroup[] }>('/search', { query, signal });
    return Array.isArray(res?.groups) ? res.groups : [];
  },
};
