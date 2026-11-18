# @qbv/api

Fastify 5 HTTP API for QuickBooks Vue (DESIGN §6.6). All routes are under
`/api`. Reads come from the Postgres read model. Writes become commands on the
relay queue, and the worker sends them to QuickBooks one at a time.

**Every qbXML document the API queues is validated against the Intuit XSD
first.** Object writes are built with `@qbv/qbxml` `buildRequest`, and raw
qbXML is checked with `validate`. `@qbv/queue` `enqueueCommand` validates
again before it stores anything. An invalid document gets a 400 with the
libxml2 errors and is never stored or queued.

```sh
npm run infra:up                  # test Postgres + Redis
npm run build -w @qbv/api         # needs @qbv/qbxml, db, queue, config, relay-client built
npm test -w @qbv/api
npm start -w @qbv/api             # node dist/main.js (env below)
```

OpenAPI: `/api/docs` (UI) and `/api/docs/json`. Both need a signed-in session or an API token (401 otherwise).

## Routes

| Route                                                                                                                            | Access                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`                                                                          | login is public (rate limited per IP); others need a caller |
| `GET /meta/entities`, `/meta/entities/:type`, `/meta/requests`, `/meta/objects/:name`                                            | any caller                                                  |
| `GET /objects/:type`, `/objects/:type/:id`                                                                                       | `object:<type>:read`                                        |
| `POST /objects/:type`, `PATCH /objects/:type/:id`, `DELETE /objects/:type/:id`, `POST /objects/:type/:id/void`                   | `object:<type>:write`                                       |
| `POST /objects/:type/live` (live query in QuickBooks), `POST /objects/:type/:id/merge`, `POST /objects/:type/:id/cleared-status` | `object:<type>:read` / `object:<type>:write`                |
| `GET /actions`, `POST /actions/:request` (SDK requests with no object route)                                                     | any caller / the per-request permissions of `POST /qbxml`   |
| `GET /commands`, `/commands/:id`                                                                                                 | own commands; `command:read` for everyone's                 |
| `POST /qbxml`, `POST /qbxml/validate`                                                                                            | `qbxml:raw`, plus per-request permissions (see below)       |
| `GET /events` (SSE)                                                                                                              | any caller; events filtered by permission                   |
| `GET/POST/PATCH /admin/users`, `/admin/roles` (+`DELETE`), `/admin/tokens` (+`DELETE` = revoke), `GET /admin/audit`              | `admin`                                                     |
| `GET /admin/sync`, `POST /admin/sync/:type`                                                                                      | `admin`                                                     |
| `GET /reports`, `GET /reports/:name`                                                                                             | any caller / `report:<name>` (from `@qbv/reports`)          |
| `GET /health`                                                                                                                    | public                                                      |

Errors always look like `{ "error": { "code", "message", "details"? } }`.

### Objects

- **List:** `q` (prefix full-text), `filter[Field]=[op:]value`, `sort=name,-txn_date`,
  `page`, `pageSize` (max 500), `includeInactive`, `includeDeleted`.
  - Operators: `ne lt lte gt gte like in isnull notnull`.
  - Fields: a column (`txn_date`), a qbXML alias (`TxnDate`, `FullName`) or a data path (`CustomerRef.ListID`).
  - Items: `{ type, id, editSequence, name, refNumber, txnDate, entityRefId, amount, isActive, timeCreated, timeModified, syncedAt, deletedAt, data }`.
- **Add:** the body uses qbXML element names. It can be bare (`{"Name":"Acme"}`)
  or wrapped (`{"CustomerAdd":{...}}`). Key order does not matter; the builder
  puts keys into schema order.
- **Mod:** the body must include `EditSequence`. The `ListID`/`TxnID` comes
  from the URL.
- **Del and Void:** these build `ListDelRq`/`TxnDelRq` and `TxnVoidRq`.
- **Write responses:** a write returns `202 { commandId, status, command }`.
  With `?wait=true` the API waits up to `COMMAND_WAIT_TIMEOUT` and returns one of:
  - 200 `{ command, object }`
  - 409 `conflict` (EditSequence out of date, 3200)
  - 422 `qb_error`
  - 400 `qbxml_rejected`
  - 202 if QuickBooks has not answered in time
- **Unsupported operations:** these return 405 `operation_not_supported`. Use
  `POST /qbxml` for them.

### Live queries and SDK actions

- **Live query:** `POST /objects/:type/live` sends the entity's query straight
  to QuickBooks (priority 2) and returns `{ type, items, total, responses }`;
  nothing is written to the read model. The body is the query content in qbXML
  element names. This is how entities whose query needs a filter are read:
  `BillToPay` (`PayeeEntityRef`), `ItemAssembliesCanBuild`
  (`ItemInventoryAssemblyRef`, `TxnDate`), `SalesTaxReturnLine`
  (`TaxAgencyVendorRef`), `Alert` (`OwnerID`) and the subscription entities
  (`SubscriberID`). `GET /meta/entities` marks them `syncable: false` with
  their `requiredFilters`. Waits by default; `?wait=false` returns 202.
- **SDK actions:** `GET /actions` lists every request that is not an entity
  Add/Mod/Query/Del/Void (ListMerge, ClearedStatusMod, SpecialAccountAdd,
  SpecialItemAdd, Txn/ListDisplay Add/Mod, DataExt/DataExtDef/Alert/
  Subscription/DataEventRecoveryInfo deletes, QBCommandExec, TransactionQuery,
  ListDeletedQuery, TxnDeletedQuery) with the permissions each needs.
  `POST /actions/:request` takes the request content in qbXML element names,
  builds it with `buildRequest` (XSD-validated; 400 when invalid) and applies
  the same per-request permissions as `POST /qbxml`. `?wait=true` returns
  `{ responses }` parsed from QuickBooks.
- **Merge:** `POST /objects/:type/:id/merge` `{ into, sameShipAddrOk? }`
  builds a `ListMergeRq`, taking both EditSequences from the read model.
- **Cleared status:** `POST /objects/:type/:id/cleared-status`
  `{ status: Cleared|NotCleared|Pending, txnLineId? }` builds a
  `ClearedStatusModRq`.

### Raw qbXML

`POST /qbxml` accepts the body as `application/xml`/`text/xml`, or as JSON
`{"qbxml":"..."}`.

- **Empty JSON bodies:** a bodiless request sent with
  `Content-Type: application/json` (common for DELETE and void) is treated as
  having no body.
- **Validation:** an invalid document gets 400 `qbxml_invalid` with
  `details.errors[] = {line, column?, message}`. Besides the XSD, a request
  must carry exactly one `<?qbxml version="N.N"?>` instruction before
  `<QBXML>` with a version QuickBooks has shipped (1.0 to 17.0); the XSD
  cannot express it, and QuickBooks cannot parse a request without it. A
  valid document that is not a request gets 400 `qbxml_not_request`.
- **Permissions:** `qbxml:raw` only opens the endpoint. Every request in the
  document also needs what the REST routes would need, or the call gets 403
  and nothing is queued: `object:<Type>:read` for queries (every type a union
  query such as `ItemQueryRq` can return; `object:*:read` for
  `TransactionQueryRq`, `ListDeletedQueryRq`, `TxnDeletedQueryRq`),
  `object:<Type>:write` for Add/Mod/Del/Void (the type comes from
  `ListDelType`/`TxnDelType`/`TxnVoidType`/`ListMergeType`), `object:*:write`
  for `ClearedStatusModRq`, `report:*` for report queries, and `admin` for
  `TxnDisplay*`/`ListDisplay*`, `QBCommandExecRq`, `SubscriptionDelRq` and
  anything else that is not an entity operation.
- **Queueing:** the document is queued as `kind: raw`, priority 2, and
  audited as `qbxml.raw`.
- **Result:** the API waits for QuickBooks and returns its response XML. The
  `X-Command-Id` header holds the command id. With `Accept: application/json`
  it returns `{ commandId, status, statusCode, statusMessage, responseXml, responses }`,
  where `responses` comes from `parseResponse`.

`POST /qbxml/validate` takes the same body and only checks it against the XSD:
it always answers 200 `{ valid, errors[], requests[], version, access[] }` and
queues nothing. `access` lists each request with the permissions `POST /qbxml`
will require and whether the caller holds them (`allowed`). The
web qbXML console uses it for live validation while typing.

- **Options:** `?wait=false` returns 202 right away.

### Auth

- **Browser:** `POST /auth/login` sets two cookies:
  - `qbv_session`: HttpOnly, signed with `SESSION_SECRET`, SameSite=Lax, Secure
    unless `COOKIE_SECURE=false`. The server stores it hashed.
  - `qbv_csrf`: readable by the page.

  Every non-GET request made with the cookie must send `X-CSRF-Token` with
  the CSRF token (double submit). The token is also returned by `/auth/login`
  and `/auth/me`.

- **Integrations:** send `Authorization: Bearer qbv_...`. Tokens are created
  in `/admin/tokens`, shown once, stored as sha256, and can be revoked or set
  to expire. No CSRF token is needed.
- **Permissions:** `admin`, `object:<Type|*>:read|write` (write implies
  read), `report:<name|*>`, `command:read` and `qbxml:raw`. They are checked
  by `@qbv/db` `hasPermission`. Every `/api` route must declare `public`,
  `authenticated` or `permission`; the app refuses to register one that does
  not.
- **Audit:** `audit_log` gets a row for every login (and failed login),
  logout, object write, raw qbXML call and admin change.
- **Rate limits:** a fixed one-minute window in Redis.
  - Writes and admin changes: one bucket per user/token, `RATE_LIMIT_WRITES_PER_MIN`.
  - Raw qbXML: `RATE_LIMIT_QBXML_PER_MIN`.
  - Login: 10 per IP.

  A request over the limit gets 429 `rate_limited` with `Retry-After`.

- **Admin safeguards:** you cannot deactivate yourself. A change that would
  leave no active admin is refused (409 `last_admin`). Changing a user's
  password or deactivating them ends their sessions.

### Events (SSE)

`GET /events` streams `object.changed`, `command.updated`, `sync.progress` and
`relay.health` from the `qbv:events` channel.

- **Filtering:** an object or sync event needs `object:<type>:read`. A command
  event goes to the user who issued the command, or to anyone with
  `command:read`.
- **Stream control:** a `ready` event is sent once the subscription is active,
  and a `: ping` comment every 15s. Streams close when the session expires.

### Sync trigger

`POST /admin/sync/:type` takes the body `{ "mode": "incremental" | "full" | "reconcile" }`.
`:type` is an entity name, or `*` for every entity. The request is RPUSHed as
JSON onto `<QUEUE_PREFIX>:sync:requests`, which apps/sync drains, so it waits
there if sync is not running. `GET /admin/sync` returns the `sync_state` rows
(`states`), the syncable `entities`, the `unsyncable` ones with the reason
(queries with required elements, which apps/sync skips as well; a test keeps
the two lists in agreement with `planSync()`) and the pending requests.

### Reports

If `@qbv/reports` is built, its `registerReportRoutes(app, deps)` is mounted
under `/api`. It receives `{ db, queue, events, cacheTtlMs, maxWaitMs, getPermissions, getActor }`.
The API itself enforces a logged-in caller and `report:<name>`. If
`@qbv/reports` is missing, `/reports` answers 501 `not_implemented`.

## Configuration

These variables are read through `@qbv/config` `loadConfig('api')`; see
docs/configuration.md.

- **Required:** `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET` (32+ characters).
- **Optional:**
  - Queue and server: `QUEUE_PREFIX` (default `qbv`), `API_HOST`, `API_PORT` (3100), `PUBLIC_URL`.
  - Sessions and cookies: `SESSION_TTL` (12h), `COOKIE_SECURE` (true), `TRUST_PROXY`, `CORS_ORIGINS`.
  - Limits and timeouts: `RATE_LIMIT_WRITES_PER_MIN` (120), `RATE_LIMIT_QBXML_PER_MIN` (60), `COMMAND_WAIT_TIMEOUT` (30s), `REPORT_CACHE_TTL` (15m).
  - qbXML: `QBXML_VERSION` (16.0), `QBXML_SCHEMA_DIR`.
  - Relay: `RELAY_URL`, `RELAY_API_KEY`, `RELAY_TIMEOUT_MS`. These are used only for `/health`.
  - Logging: `LOG_LEVEL`, `LOG_PRETTY`.

The XSDs must be present: the app loads the schema at startup and refuses to
start without it.

## Tests

`npm test` uses the test infra: Postgres on 127.0.0.1:55433 (a throwaway
database per file) and Redis on 56379 (a random queue prefix per file).

- **Injected requests:** the tests use `fastify.inject`.
- **SSE:** the SSE tests listen on a real port.
- **Stand-in worker:** a BullMQ worker that:
  - asserts each queued request is XSD-valid,
  - answers with responses from `buildResponse`, which are also XSD-valid,
  - writes through to the read model.
