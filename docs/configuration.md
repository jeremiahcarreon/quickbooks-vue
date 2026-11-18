# Configuration

All configuration is environment variables. Services parse them with
`@qbv/config` (`loadConfig(service)`), which fails at startup with a list of
every missing or invalid variable. Empty values count as unset.

`.env*` files are managed by the owner only; contributors never create or edit
them. Put values in the environment of the process or in Compose.

Durations accept `500ms`, `30s`, `5m`, `1h`, `1d`. A bare number is read in the
unit noted in the table. Booleans accept `true/false/1/0/yes/no/on/off`.

## Common (every Node service)

| Variable     | Default       | Notes                                                        |
| ------------ | ------------- | ------------------------------------------------------------ |
| `NODE_ENV`   | `development` | `development`, `production` or `test`                        |
| `LOG_LEVEL`  | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `LOG_PRETTY` | `false`       | Human-readable logs via pino-pretty (development only)       |

## Database (api, worker, sync, migrate, seed)

| Variable            | Default  | Notes                                      |
| ------------------- | -------- | ------------------------------------------ |
| `DATABASE_URL`      | required | `postgres://user:pass@host:5432/db`        |
| `DATABASE_POOL_MAX` | `10`     | Connections per process                    |
| `DATABASE_SSL`      | `false`  | TLS to Postgres (certificate not verified) |

## Redis / queue (api, worker, sync)

| Variable       | Default  | Notes                                |
| -------------- | -------- | ------------------------------------ |
| `REDIS_URL`    | required | `redis://host:6379/0` or `rediss://` |
| `QUEUE_PREFIX` | `qbv`    | BullMQ key prefix                    |

## qbXML (api, worker, sync, relay-mock)

| Variable           | Default                     | Notes                                                                           |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------- |
| `QBXML_VERSION`    | `16.0`                      | Written in the `<?qbxml version?>` header. Validation always uses the 17.0 XSD. |
| `QBXML_SCHEMA_DIR` | `<repo>/schemas/qbxml/17.0` | Directory holding `QBUqbxmlops170.xsd`. Images set `/app/schemas/qbxml/17.0`.   |

## Relay (worker; optional for api)

| Variable           | Default                               | Notes                                                                                                                                                                                                      |
| ------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_URL`        | required for worker; optional for api | The api uses it only for `/api/health` (cached 10s); without it health shows the worker's last `relay.health` event. e.g. `http://10.0.0.5:9123` over the private network; `http://relay-mock:9223` in dev |
| `RELAY_API_KEY`    | empty                                 | Sent as `X-Api-Key`; must match the relay's `ApiKey`                                                                                                                                                       |
| `RELAY_TIMEOUT_MS` | `130000`                              | Client timeout per request (ms). The relay's own limit is 120s.                                                                                                                                            |

## api

| Variable                    | Default                 | Notes                                                   |
| --------------------------- | ----------------------- | ------------------------------------------------------- |
| `API_HOST`                  | `0.0.0.0`               |                                                         |
| `API_PORT`                  | `3100`                  |                                                         |
| `PUBLIC_URL`                | `http://localhost:8180` | External URL of the web app (cookies, CORS, links)      |
| `SESSION_SECRET`            | required                | At least 32 characters                                  |
| `SESSION_TTL`               | `12h`                   | Duration                                                |
| `COOKIE_SECURE`             | `true`                  | Set `false` only for plain-HTTP development             |
| `TRUST_PROXY`               | `false`                 | `true` behind nginx / a reverse proxy (Compose sets it) |
| `CORS_ORIGINS`              | empty                   | Comma list of extra allowed origins                     |
| `RATE_LIMIT_WRITES_PER_MIN` | `120`                   | Per user/token                                          |
| `RATE_LIMIT_QBXML_PER_MIN`  | `60`                    | Per user/token, raw qbXML endpoint                      |
| `COMMAND_WAIT_TIMEOUT`      | `30s`                   | Max wait for `?wait=true`                               |
| `REPORT_CACHE_TTL`          | `15m`                   | Bare number = seconds                                   |

Fixed, not configurable: the login rate limit (10 attempts per minute per IP),
and report waiting (a QuickBooks report request waits up to 20s, at most 60s
with `?wait=`, before answering 202 `{status:'pending', commandId}`).

## worker

| Variable                   | Default | Notes                                                                                                                                                                                                                    |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WORKER_MAX_ATTEMPTS`      | `5`     | Retries for transient relay failures (503/504/network)                                                                                                                                                                   |
| `WORKER_BACKOFF`           | `2s`    | Base of the backoff for jobs enqueued with `backoff: {type: 'custom'}`. Jobs from `@qbv/queue` `enqueueCommand` carry their own exponential 2s backoff; attempts are capped at min(job attempts, `WORKER_MAX_ATTEMPTS`). |
| `RELAY_HEALTH_INTERVAL`    | `15s`   | Relay health polling                                                                                                                                                                                                     |
| `CIRCUIT_BREAKER_COOLDOWN` | `30s`   | Pause after the relay is found unhealthy                                                                                                                                                                                 |

Give the worker container a stop grace period of at least `RELAY_TIMEOUT_MS`
(apps/worker/compose.yaml sets 150s) so a request in flight can finish on shutdown.

## sync

| Variable                     | Default     | Notes                                                                                |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `SYNC_ENABLED`               | `true`      |                                                                                      |
| `SYNC_INTERVAL`              | `60s`       | Incremental sync interval. Bare number = seconds.                                    |
| `SYNC_FULL_INTERVAL`         | `1h`        | Full re-query for entities without a modified-date filter. Bare number = seconds.    |
| `SYNC_PAGE_SIZE`             | `500`       | `MaxReturned` per iterator page                                                      |
| `SYNC_RECONCILE_CRON`        | `0 3 * * *` | Nightly ID-only reconcile                                                            |
| `SYNC_ENTITIES`              | empty (all) | Comma list to restrict which entities sync                                           |
| `SYNC_OVERLAP`               | `1m`        | Incremental queries start at cursor minus this (absorbs clock skew)                  |
| `SYNC_COMMAND_TIMEOUT`       | `30m`       | How long sync waits for one query command                                            |
| `SYNC_PRUNE_RESPONSES`       | `true`      | Clear `response_xml` of sync commands once processed (keeps the command table small) |
| `SYNC_INCLUDE_CUSTOM_FIELDS` | `true`      | Send `OwnerID 0` so custom fields come back                                          |
| `SYNC_LOCK_TTL`              | `30s`       | Leader lock TTL (`<QUEUE_PREFIX>:sync:leader`); several sync replicas are safe       |
| `TZ`                         | `UTC`       | Time zone of `SYNC_RECONCILE_CRON`                                                   |

Manual syncs: `POST /api/admin/sync/:type` with `{"mode":"incremental"|"full"|"reconcile"}`
(`:type` is an entity name or `*`) pushes a request onto the Redis list
`<QUEUE_PREFIX>:sync:requests`, which the sync leader drains about once a second.

## relay-mock (development and tests only)

| Variable                                     | Default                                                | Notes                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_MOCK_HOST`                            | `0.0.0.0`                                              |                                                                                                                                                                                              |
| `RELAY_MOCK_PORT`                            | `9223`                                                 |                                                                                                                                                                                              |
| `RELAY_API_KEY`                              | empty                                                  | Key the mock expects                                                                                                                                                                         |
| `SEED`                                       | `false` (`1` in Compose)                               | Load the sample HVAC company when the store is empty                                                                                                                                         |
| `MOCK_SEED_ANCHOR`                           | `2026-10-31`                                           | Last day of the seeded year, or `today`                                                                                                                                                      |
| `MOCK_COMPANY_NAME`                          | `Summit Air Heating & Cooling`                         |                                                                                                                                                                                              |
| `MOCK_DATA_FILE`                             | unset (`/app/data/relay-mock-company.json` in Compose) | JSON file loaded at start and saved after writes. Compose keeps it on the `relaymock` volume so the company survives restarts; set `RELAY_MOCK_DATA_FILE=` (empty) for an in-memory company. |
| `MOCK_LATENCY_MS` / `MOCK_LATENCY_JITTER_MS` | `0` / `0`                                              | Simulated QuickBooks processing time                                                                                                                                                         |
| `MOCK_REQUEST_TIMEOUT_MS`                    | `120s`                                                 | Timeout used by the `timeout` fault                                                                                                                                                          |
| `MOCK_ALLOWED_IPS`                           | empty (everyone)                                       | Comma list, like the relay's `AllowedIPs`; loopback always allowed                                                                                                                           |

Compose maps `RELAY_MOCK_SEED`, `RELAY_MOCK_SEED_ANCHOR`, `RELAY_MOCK_LATENCY_MS`,
`RELAY_MOCK_LATENCY_JITTER_MS` and `RELAY_MOCK_DATA_FILE` onto these.

## Windows relay (server/)

The .NET relay is configured with `appsettings.json` next to the executable,
not environment variables: `ApiKey`, `AllowedIPs`, `ValidateSchema`
(`enforce` by default, or `log`/`off`), `SchemaDir`, `MaxRequestBodyBytes` and more. See
[server/README.md](../server/README.md#configuration).

## Seed (first admin, default roles)

| Variable         | Default         | Notes                                                                         |
| ---------------- | --------------- | ----------------------------------------------------------------------------- |
| `ADMIN_EMAIL`    | unset           | With `ADMIN_PASSWORD`, creates the first admin if it does not exist           |
| `ADMIN_PASSWORD` | unset           | At least 12 characters; hashed with argon2id. Never changes an existing user. |
| `ADMIN_NAME`     | `Administrator` | Display name                                                                  |

The dev overlay (`compose.dev.yaml`) gives the `migrate` service development-only
defaults for `ADMIN_EMAIL` and `ADMIN_PASSWORD` (see that file) so a fresh dev
stack has a login; set both variables to override them. Production
(`compose.yaml` alone) has no defaults.

## Compose

Read by `compose.yaml`, the app fragments in `apps/*/compose.yaml` and `compose.dev.yaml`.

| Variable                                                                                                               | Default               | Notes                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`                                                                  | `qbv` / `qbv` / `qbv` | Set a real password in production. Postgres is not published outside the Compose network. |
| `WEB_BIND`                                                                                                             | `127.0.0.1`           | Host address the web container is published on                                            |
| `WEB_PORT`                                                                                                             | `8180`                | Host port of the web container (put TLS in front of it)                                   |
| `API_UPSTREAM`                                                                                                         | `http://api:3100`     | nginx `/api` proxy target inside the web container                                        |
| `PUBLIC_URL`, `SESSION_SECRET`, `RELAY_URL`, `RELAY_API_KEY`, `SYNC_INTERVAL`, `QBXML_VERSION`, `LOG_LEVEL`, `ADMIN_*` | see above             | Passed through to the services                                                            |

Development overlay (`npm run dev:up`), all bound to 127.0.0.1:

| Variable              | Default | Service    |
| --------------------- | ------- | ---------- |
| `QBV_PG_PORT`         | `55434` | postgres   |
| `QBV_REDIS_PORT`      | `56380` | redis      |
| `QBV_API_PORT`        | `3100`  | api        |
| `QBV_WEB_PORT`        | `8180`  | web        |
| `QBV_RELAY_MOCK_PORT` | `9223`  | relay-mock |

The dev overlay supplies a development-only `SESSION_SECRET` and
`RELAY_API_KEY=dev-relay-key` when they are unset, and turns `COOKIE_SECURE` off.

## Tests

`npm run infra:up` starts Postgres and Redis (Compose project `qbv-test`,
`compose.test.yaml`, data in tmpfs). `npm run infra:down` removes them.

| Variable              | Default                                  | Notes                                                                                         |
| --------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `QBV_TEST_PG_PORT`    | `55433`                                  | Host port of the test Postgres (user/password/db `qbv`)                                       |
| `QBV_TEST_REDIS_PORT` | `56379`                                  | Host port of the test Redis                                                                   |
| `TEST_DATABASE_URL`   | `postgres://qbv:qbv@127.0.0.1:55433/qbv` | Used by `@qbv/db/testing` `createTestDatabase()` (creates a throwaway database per test file) |
| `TEST_REDIS_URL`      | `redis://127.0.0.1:56379/0`              | Used by `@qbv/config/testing` `testRedisUrl()`                                                |

End-to-end tests (`npm run test:e2e`, Playwright in `e2e/`) run against the
dev stack:

| Variable                                 | Default                                                         | Notes                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `E2E_BASE_URL`                           | `http://localhost:8180`                                         | Web app (nginx) of the stack under test; the Vite dev server (`http://127.0.0.1:5273`) works too |
| `E2E_RELAY_MOCK_URL`                     | `http://127.0.0.1:9223`                                         | Relay mock control endpoints                                                                     |
| `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` | `ADMIN_EMAIL` / `ADMIN_PASSWORD`, else the dev overlay defaults | Admin login                                                                                      |
| `RELAY_API_KEY`                          | `dev-relay-key`                                                 | Relay mock key                                                                                   |

## Web build

| Variable         | Default                 | Notes                                                             |
| ---------------- | ----------------------- | ----------------------------------------------------------------- |
| `VITE_API_PROXY` | `http://127.0.0.1:3100` | Target of the Vite dev server's `/api` proxy (dev server on 5273) |

## Adding a variable

1. Add it to the right fragment in `packages/config/src/env.ts` with a default
   (or mark it required) and a test.
2. Document it here.
3. Pass it through in the app's `apps/<app>/compose.yaml` if it should be
   settable from Compose.
