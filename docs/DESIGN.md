# QuickBooks Vue — Platform Design

Status: implemented · Owner: Jeremiah Carreon · Last updated: 2026-11-17

## 1. Goal

Give QuickBooks Desktop Enterprise a modern web front end and an open
integration API, reachable from anywhere the operator chooses to expose it:

- **Web UI** (Vue 3) that covers everything the qbXML SDK exposes: lists,
  transactions, reports, plus a raw qbXML console.
- **Integration API**: any application can read and write the company file,
  either through a JSON REST API or by sending raw qbXML that follows the
  Intuit schema.
- **Fast for many concurrent users** even though QuickBooks itself handles
  one request at a time.

Non-goals: features that are not in the SDK (payroll processing, bank feeds,
bank reconciliation, closing-date and QB user administration, form template
design, most company preferences). The UI shows these as "use QuickBooks
Desktop" rather than faking them.

## 2. The core constraint

QuickBooks Desktop processes SDK requests serially, through a COM object on
the Windows machine that holds the company file, under one QB user. Anything
that waits on QuickBooks for a page load will be slow under load.

So the design is **CQRS**:

- **Reads** never touch QuickBooks. They come from a Postgres _read model_
  that mirrors the company file.
- **Writes** are _commands_. They go into a priority queue, and a single
  worker sends them to QuickBooks one at a time through the relay.
- **QuickBooks stays the source of truth.** Postgres is a cache that can be
  rebuilt from scratch at any time with a full sync.

```
 Browser (Vue)        3rd-party apps
      │  REST/SSE          │ REST or raw qbXML
      ▼                    ▼
 ┌──────────────────────────────────┐
 │ api  (Fastify)                   │──reads──► Postgres (read model,
 │  auth · RBAC · audit · reports   │           commands, audit, users)
 └──────────────┬───────────────────┘                ▲
                │ enqueue                            │ write-through
                ▼                                    │
          Redis (BullMQ "relay" queue, pub/sub) ─► worker (concurrency 1)
                ▲                                    │ HTTP + API key
                │ enqueue queries                    ▼
             sync (scheduler)              Relay (.NET, Windows) ──COM──► QuickBooks
```

## 3. Decisions

| Topic          | Decision                                                                                        | Why                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Read store     | **Postgres 16**, one generic table + JSONB                                                      | Real queries, joins, aggregates, full-text. Redis can't do ad-hoc queries and must hold everything in RAM. |
| Redis          | Queue (BullMQ), pub/sub, short-lived cache, locks                                               | What it is good at. Never the system of record.                                                            |
| Language       | **TypeScript on Node 22** for everything except the relay                                       | One language from schema → API → UI; types generated once from the XSD and shared.                         |
| Relay          | Existing **.NET 8** Windows service, unchanged contract                                         | Must run in an interactive Windows session for QBXMLRP2. Cannot be containerised.                          |
| Monorepo       | **npm workspaces** (`apps/*`, `packages/*`)                                                     | No extra tooling needed.                                                                                   |
| API            | **Fastify 5**, Zod validation, Kysely for SQL                                                   | Fast, typed, small.                                                                                        |
| Web            | **Vue 3 + Vite + TypeScript + Pinia + vue-router + PrimeVue 4**                                 | PrimeVue DataTable/forms suit a data-heavy accounting app.                                                 |
| XSD validation | **libxml2** (`libxml2-wasm` in Node; `xmllint` in scripts)                                      | Same engine already proven against these schemas in production.                                            |
| Live updates   | Server-Sent Events from the API                                                                 | One-way, proxy-friendly, simple.                                                                           |
| Deployment     | Docker Compose; relay on the Windows host, reached over a private network (WireGuard/Tailscale) | The relay must never be internet-facing.                                                                   |

## 4. The schema is the contract

**Every qbXML document that leaves this system must be validated against the
Intuit XSD before it is sent.** A request QuickBooks cannot parse can drop the
QB session or raise a modal dialog that blocks everything until someone clicks
OK at the server. qbXML is `xsd:sequence` throughout, so element _order_
matters; hand-built XML gets it wrong.

- Schemas: `schemas/qbxml/17.0/` (`QBUqbxmlops170.xsd` is the entry point;
  it includes the other three).
- **The XSD files are Intuit-confidential and are not in git.** Copy them from
  the QuickBooks SDK (`QBSDK*/tools/...`) or an existing install into
  `schemas/qbxml/17.0/`. `QBXML_SCHEMA_DIR` overrides the location.
- Code generated from the schemas (`packages/qbxml/generated/`) is also not
  committed. `npm run codegen` rebuilds it; `npm install` runs it.
- The wire version header defaults to `16.0` (what QB Enterprise accepts),
  set by `QBXML_VERSION`. Validation always uses the 17.0 schema, a superset.
- Validation is enforced in three places: `@qbv/qbxml` `buildRequest()`
  (throws), the worker right before sending (rejects the command), and the
  raw qbXML endpoint (400 with the libxml2 error).
- Tests that produce qbXML must assert it validates. The relay mock also
  validates every request it receives and returns QB's parse error if it
  doesn't, so integration tests catch any gap.

## 5. Repository layout and ownership

```
apps/
  api/            REST + SSE + raw qbXML endpoint, auth, RBAC, audit
  worker/         single consumer of the relay queue
  sync/           scheduler: initial load, incremental, deletes, reconcile
  relay-mock/     fake relay for dev/test: XSD-validating, stateful
  web/            Vue SPA
packages/
  qbxml/          schema loading, validation, codegen, build/parse
  db/             Kysely schema types, migrations, repository helpers
  queue/          BullMQ queue names, job types, event channel helpers
  relay-client/   HTTP client for the relay contract
  config/         env parsing (Zod), logger (pino)
  reports/        report definitions (SQL + QB report fetch/parse)
server/           .NET relay (Windows)
schemas/qbxml/    local-only XSDs
docker/           shared Dockerfiles, nginx config
compose.yaml      includes apps/*/compose.yaml
```

Components talk to each other only through the contracts in §6. Each app
ships its own `compose.yaml` fragment; the root `compose.yaml` pulls them in
with `include:`.

## 6. Contracts

### 6.1 `@qbv/qbxml`

```ts
// Schema + validation
loadSchema(dir?: string): Promise<QbSchema>          // default QBXML_SCHEMA_DIR
validate(xml: string): ValidationResult               // { valid, errors: {line, message}[] }

// Catalog generated from the XSD (generated/catalog.json)
catalog.requests: Record<string, RequestDef>          // 'CustomerAddRq' → {...}
catalog.objects:  Record<string, ObjectDef>           // 'CustomerAdd', 'CustomerRet', 'InvoiceLineAdd' ...
catalog.entities: Record<string, EntityDef>           // 'Customer', 'Invoice' ...

interface FieldDef { name: string; kind: 'simple'|'complex'; type: string;  // base xsd type e.g. STRTYPE, AMTTYPE, IDTYPE, DATETYPE, BOOLTYPE, ENUMTYPE
  minOccurs: number; maxOccurs: number|'unbounded'; maxLength?: number; enum?: string[];
  choiceGroup?: string; children?: string /* ObjectDef name */ }
interface ObjectDef { name: string; fields: FieldDef[] /* in schema order */ }
interface RequestDef { name: string; response: string; op: 'Add'|'Mod'|'Query'|'Del'|'Void'|'Other';
  entity?: string; bodyElement?: string; retElement?: string; supportsIterator: boolean;
  filters: string[] /* top-level query filter elements */ }
interface EntityDef { name: string; category: 'list'|'txn'|'other'; idField: 'ListID'|'TxnID'|null;
  ops: { add?: string; mod?: string; query?: string; del?: string; void?: string };
  retElement: string; supportsModifiedFilter: boolean; delType?: string /* ListDelType/TxnDelType value */ }

// Build & parse
buildRequest(rq: string, body: object, opts?: { requestID?: string; onError?: 'stopOnError'|'continueOnError';
  version?: string; iterator?: 'Start'|'Continue'|'Stop'; iteratorID?: string }): string  // ordered, escaped, VALIDATED; throws QbxmlValidationError
buildBatch(parts: {rq, body, opts}[], onError?): string
parseResponse(xml: string): ParsedRs[]
interface ParsedRs { name: string; requestID?: string; statusCode: number; statusSeverity: 'Info'|'Warn'|'Error';
  statusMessage: string; rets: Record<string, unknown>[]; retName?: string;
  iteratorID?: string; iteratorRemainingCount?: number; raw: string }
```

JS shape mirrors qbXML: element names as keys, repeated elements as arrays
(decided by `maxOccurs` from the catalog, so a single line is still an array),
leaf values as strings. Typed views (numbers, booleans, dates) are produced by
helpers, not by the parser, so values round-trip losslessly.

### 6.2 Database (`@qbv/db`, Postgres)

```sql
qb_object (
  type text, qb_id text,                    -- 'Customer', ListID/TxnID
  edit_sequence text, name text,            -- FullName for lists
  ref_number text, txn_date date,
  entity_ref_id text,                       -- CustomerRef/VendorRef/EntityRef ListID
  amount numeric(18,5), is_active boolean,
  time_created timestamptz, time_modified timestamptz,
  data jsonb not null,                      -- full parsed Ret
  synced_at timestamptz not null, deleted_at timestamptz,
  search tsvector generated,                -- name, ref_number, memo
  primary key (type, qb_id) )
  -- indexes: (type, time_modified), (type, name), (type, txn_date), (type, entity_ref_id), GIN(search), GIN(data jsonb_path_ops)

sync_state (type pk, last_modified_cursor timestamptz, last_full_sync_at, last_run_at, status, error, row_count)
command   (id uuid pk, kind 'add'|'mod'|'del'|'void'|'raw'|'query'|'report', rq_name, object_type, object_id,
           payload jsonb, request_xml text, response_xml text, status 'queued'|'sending'|'succeeded'|'failed'|'conflict'|'rejected',
           priority int, status_code int, status_message text, result jsonb, attempts int,
           actor_type 'user'|'token'|'system', actor_id, created_at, started_at, finished_at)
app_user  (id uuid, email unique, display_name, password_hash, is_active, created_at, last_login_at)
role      (id, name unique, permissions text[])        -- e.g. 'object:Invoice:read', 'object:*:write', 'report:*', 'admin'
user_role (user_id, role_id)
session   (id text pk, user_id, expires_at, ip, user_agent)
api_token (id uuid, name, token_hash, permissions text[], created_by, last_used_at, revoked_at)
audit_log (id bigserial, at, actor_type, actor_id, action, object_type, object_id, command_id, ip, detail jsonb)
report_cache (key text pk, report text, params jsonb, result jsonb, fetched_at, expires_at)
```

Migrations live in `packages/db/src/migrations` (Kysely migrator, registered in a static map so they run from `dist` and inside images). The `qb_object`
column extraction (`name`, `amount`, `entity_ref_id`, ...) is done by
`toRow(entityDef, ret)` in `@qbv/db`, driven by the catalog, so every entity gets
it for free.

### 6.3 Queue (`@qbv/queue`)

- One BullMQ queue, `relay`. **The worker is the only thing that talks to the
  relay.** Sync and report fetches go through the same queue so QuickBooks
  never sees two requests at once.
- Job data: `{ commandId: string }`. The command row holds everything else.
- Priorities (lower runs first): `1` interactive writes, `2` interactive raw
  qbXML/lookups, `5` incremental sync, `8` report fetch, `10` bulk/initial sync.
- Callers that need the result await it with `QueueEvents` /
  `job.waitUntilFinished`, or watch `command.updated` events.
- Pub/sub channel `qbv:events`, JSON messages:
  `{ type: 'object.changed', objectType, qbId, op }`,
  `{ type: 'command.updated', id, status }`,
  `{ type: 'sync.progress', objectType, status, count }`,
  `{ type: 'relay.health', connected }`.

### 6.4 Worker semantics

1. Load command, mark `sending`. Re-validate `request_xml` against the XSD;
   on failure mark `rejected` (never sent).
2. POST to relay `/qb/request`. Timeout per relay config. On 503/504/network
   error: retry with backoff (max 5), command stays queued; publish
   `relay.health`. Circuit-break while the relay is unhealthy.
3. Parse response. `statusCode 0` (or warning 1–999) → `succeeded`; upsert
   every returned Ret into `qb_object` immediately (write-through), publish
   `object.changed`. Del → set `deleted_at`.
4. `3200` (EditSequence out of date) → `conflict`; refresh that object with a
   query and store it in `result.current` so the UI can show a diff.
5. Any other error → `failed`, keeping QB's status code and message.
6. Write an `audit_log` row for every write command.

### 6.5 Relay contract (unchanged)

`POST /qb/request {qbxml}` → `{response, error}`; `GET /qb/health`;
`X-Api-Key` header; 401/403/502/503/504 as documented in `server/README.md`.
`apps/relay-mock` implements exactly this contract.

### 6.6 HTTP API (`/api`)

| Method & path                                                  | Purpose                                                                                                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`        | Session cookie auth                                                                                                                                      |
| `GET /meta/entities`, `GET /meta/entities/:type`               | Catalog for the UI (fields, ops, enums, lengths)                                                                                                         |
| `GET /objects/:type`                                           | List: `q`, `filter[field]=`, `sort`, `page`, `pageSize`, `includeInactive`                                                                               |
| `GET /objects/:type/:id`                                       | One object (from read model)                                                                                                                             |
| `POST /objects/:type`                                          | Add → `202 {commandId}` (`?wait=true` waits up to 30s and returns the result)                                                                            |
| `PATCH /objects/:type/:id`                                     | Mod; body must include `EditSequence`                                                                                                                    |
| `DELETE /objects/:type/:id`                                    | Del                                                                                                                                                      |
| `POST /objects/:type/:id/void`                                 | Void                                                                                                                                                     |
| `GET /commands`, `GET /commands/:id`                           | Command status/history                                                                                                                                   |
| `POST /qbxml`                                                  | Raw qbXML for integrations. Validated; 400 with libxml2 errors if invalid. Queries return QB's response; writes also update the read model.              |
| `POST /qbxml/validate`                                         | XSD check only (`{valid, errors}`), nothing queued; used by the console's live validation                                                                |
| `GET /reports`, `GET /reports/:name`                           | Report list / run (see 6.7)                                                                                                                              |
| `GET /events`                                                  | SSE stream of `qbv:events` the caller may see                                                                                                            |
| `GET/POST/PATCH /admin/users`, `/admin/roles`, `/admin/tokens` | Administration                                                                                                                                           |
| `GET /admin/sync`, `POST /admin/sync/:type`                    | Sync status / trigger resync (`{mode: incremental\|full\|reconcile}`, `:type` an entity or `*`; queued on the Redis list `<QUEUE_PREFIX>:sync:requests`) |
| `GET /health`                                                  | api + db + redis + relay status                                                                                                                          |

Auth: browser uses an HttpOnly session cookie; integrations use
`Authorization: Bearer <api token>`. Every route checks permissions. JSON
bodies for objects use the same element-named shape as §6.1. Errors:
`{ error: { code, message, details? } }`.

### 6.7 Reports (`@qbv/reports`)

- **Operational reports** run as SQL over `qb_object` (A/R & A/P aging, open
  invoices, open POs/sales orders, customer/vendor balances, sales by
  customer/item, transaction lists). Fast, any user, any time.
- **Financial statements and other QB reports** (P&L, balance sheet, trial
  balance, cash flow, general ledger, all `GeneralSummaryReportQuery` /
  `GeneralDetailReportQuery` / `AgingReportQuery` / `BudgetSummaryReportQuery`
  / `CustomSummaryReportQuery` types) are fetched from QuickBooks through the
  queue at priority 8 and cached in `report_cache` (default TTL 15 min,
  refresh on demand). These numbers stay authoritative.
- Export: `registerReportRoutes(app, deps)`; output is a normalized
  `{ columns, rows, totals, meta }` for both kinds.

### 6.8 Sync

- For each entity in `catalog.entities` that has a query op: initial load with
  iterators (`MaxReturned` 500) at priority 10, then incremental every
  `SYNC_INTERVAL` (default 60s) using `FromModifiedDate = cursor - 1 min`
  (overlap absorbs clock skew), at priority 5.
- Deletions: `ListDeletedQuery` / `TxnDeletedQuery` since the cursor.
- Nightly reconcile: full ID-only query per type
  (`IncludeRetElement ListID/TxnID, EditSequence`) to catch anything missed.
- Entities without a modified-date filter are fully re-queried on a slower
  interval.
- Status in `sync_state`, progress on `sync.progress`.

## 7. Web UI

- Shell: login, sidebar navigation by area (Customers, Vendors, Employees,
  Banking, Company, Lists, Reports, Admin), global search, live command
  tray (pending/failed/conflict writes), relay health indicator.
- **Generic, metadata-driven screens** for every entity in the catalog: list
  (server-side paging, filtering, sorting), detail, and add/edit forms
  generated from the Add/Mod object definitions (field types, lengths, enums,
  ref pickers). This is how "everything in the SDK" stays maintainable.
- **Purpose-built screens** for daily work: invoice, sales receipt, estimate,
  sales order, credit memo, receive payment, bill, pay bills, check, purchase
  order, item receipt, journal entry, deposit, transfer; customer/vendor
  centers; home dashboard.
- Reports area; raw qbXML console (with live XSD validation) for admins.
- Optimistic UX: writes show "pending" from the command until QB confirms;
  conflicts show a field diff with "reload & reapply".
- Modules register themselves: `apps/web/src/modules/<name>/index.ts` exports
  `{ routes, nav }`, picked up with `import.meta.glob`.

## 8. Security

- Only the `api` and `web` containers are exposed (behind TLS at a reverse
  proxy). The relay listens on a private network only; its API key lives in
  the server env, never in the browser.
- Passwords: argon2id. Sessions: HttpOnly, Secure, SameSite=Lax; CSRF token
  for state-changing browser requests. API tokens stored hashed.
- Every write is attributed in `audit_log`. In QuickBooks itself, all SDK
  writes appear as the relay's QB user, so this log is the real audit trail.
- Rate limiting per user/token on writes and raw qbXML.

## 9. Deployment

`docker compose up` brings up `postgres`, `redis`, `api`, `worker`, `sync`,
`web` (nginx serving the SPA, proxying `/api`). `compose.dev.yaml` adds
`relay-mock` and points `RELAY_URL` at it, so the whole stack runs on Linux
without QuickBooks. In production `RELAY_URL` points at the Windows relay
across the private network.

Configuration is env-based; `docs/configuration.md` documents every
variable. `.env*` files are local to each deployment and never committed.

## 10. Components

Foundation:

| Component  | Scope                                                                                | Location                                                         |
| ---------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| qbxml core | XSD loading, validation, codegen catalog/types, build/parse                          | `packages/qbxml`                                                 |
| platform   | workspace, config/logger, db + migrations, queue, relay client, Dockerfiles, compose | root files, `packages/{config,db,queue,relay-client}`, `docker/` |

Services and UI:

| Component        | Scope                                                                           | Location                                           |
| ---------------- | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| relay mock       | XSD-validating, stateful stand-in for the relay                                 | `apps/relay-mock`                                  |
| worker           | single consumer of the relay queue                                              | `apps/worker`                                      |
| sync             | initial load, incremental, deletes, reconcile                                   | `apps/sync`                                        |
| api              | REST, auth, RBAC, audit, tokens, SSE, raw qbXML                                 | `apps/api`                                         |
| reports          | SQL and QuickBooks-sourced reports                                              | `packages/reports`, `apps/web/src/modules/reports` |
| web core         | shell, auth screens, generic entity screens, command tray, qbXML console, admin | `apps/web`                                         |
| web transactions | purpose-built forms, centers, home                                              | `apps/web/src/modules/{transactions,centers,home}` |
| relay & ops      | XSD validation in the relay, health detail, deployment and networking guides    | `server/`, `docs/ops/`                             |

End-to-end tests (Playwright, `e2e/`) run the full stack from
`compose.dev.yaml` against the relay mock.

## 11. Definition of done (every component)

- `npm run build`, `npm run lint`, `npm test` pass.
- Every code path that emits qbXML has a test asserting XSD validity.
- No secrets in code; config via env, documented in `docs/configuration.md`.
- No Intuit XSD content or generated output committed.
- Short README in each app/package.
