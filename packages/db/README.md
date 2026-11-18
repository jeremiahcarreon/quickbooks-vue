# @qbv/db

Postgres schema, migrations and repository helpers (Kysely + pg). Tables follow
DESIGN section 6.2: `qb_object` (read model), `sync_state`, `command`,
`app_user`, `role`, `user_role`, `session`, `api_token`, `audit_log`,
`report_cache`.

```ts
import { createDbFromConfig, upsertObjects, queryObjects, parseFilterParam } from '@qbv/db';

const db = createDbFromConfig(loadConfig('worker'));
await upsertObjects(db, catalog.entities.Invoice, rets); // write-through / sync
const page = await queryObjects(db, {
  type: 'Invoice',
  q: 'smith',
  sort: '-txn_date',
  page: 1,
  pageSize: 50,
  filters: [
    parseFilterParam('TxnDate', 'gte:2024-01-01'),
    parseFilterParam('CustomerRef.ListID', '80000001-1700000000'),
  ],
});
```

## Migrations and seed

```sh
npm run build -w @qbv/db
DATABASE_URL=postgres://... npm run migrate -w @qbv/db            # latest (also: up | down | status)
DATABASE_URL=postgres://... ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed -w @qbv/db
```

Migrations live in `src/migrations/NNNN_name.ts` and are registered in
`src/migrations/index.ts` (a static map, so they work from `dist/` and in
images). The seed creates the default roles (Admin, Accountant, Sales,
Purchasing, ReadOnly) and, when `ADMIN_EMAIL`/`ADMIN_PASSWORD` are set, the
first admin (argon2id). It never overwrites existing users or roles.

## What is in here

| Module         | Exports                                                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`       | `Database` and row types, `COMMAND_KINDS`, `COMMAND_STATUSES`, `TERMINAL_COMMAND_STATUSES`                                                                                                                                                                             |
| `client`       | `createDb`, `createDbFromConfig` (`date` columns come back as `YYYY-MM-DD` strings; `numeric` as strings)                                                                                                                                                              |
| `to-row`       | `toRow(entityDef, ret)`: column extraction for `qb_object` (id, EditSequence, FullName/Name, RefNumber, TxnDate, counterparty ref, amount, IsActive, timestamps). For transactions `name` is the customer/vendor/payee FullName. Per-entity `overrides` are supported. |
| `objects`      | `upsertObjects` (stale-safe by TimeModified, chunked), `markDeleted`, `markMissingDeleted` (reconcile), `getObject(s)`, `queryObjects` (paging, filters on columns, qbXML aliases or JSON paths, sort, prefix full-text), `parseFilterParam`, `parseSort`              |
| `commands`     | `createCommand`, `getCommand`, `markCommandSending`, `requeueCommand`, `finishCommand`, `updateCommand`, `listCommands` (keyset), `listPendingCommands`                                                                                                                |
| `sync-state`   | `getSyncState`, `listSyncStates`, `upsertSyncState`, `resetSyncState`                                                                                                                                                                                                  |
| `audit`        | `writeAudit`, `listAudit`                                                                                                                                                                                                                                              |
| `report-cache` | `reportCacheKey`, `getReportCache`, `putReportCache`, `purgeExpiredReports`                                                                                                                                                                                            |
| `auth`         | `hashPassword`/`verifyPassword` (argon2id), `hashToken`, `generateToken`, `hasPermission`, `getUserPermissions`, `findUserByEmail`, `DEFAULT_ROLES`                                                                                                                    |
| `json`         | `jsonb(value)`: bind any value as jsonb (needed for top-level arrays)                                                                                                                                                                                                  |

Filter syntax (`parseFilterParam`): `value` (equals), `ne:`, `lt:`, `lte:`,
`gt:`, `gte:`, `like:` (case-insensitive contains), `in:a,b,c`, `isnull:`,
`notnull:`. Fields: a column (`txn_date`), a qbXML alias (`TxnDate`,
`FullName`, `ListID`, `IsActive`, ...) or a JSON path (`CustomerRef.ListID`).
Equality on JSON paths uses the GIN index.

## Tests

`@qbv/db/testing` exports `createTestDatabase()`, which creates and migrates a
throwaway database on the test server and drops it on `destroy()`. Other
packages can use it too.

```sh
npm run infra:up          # Postgres 127.0.0.1:55433, Redis 127.0.0.1:56379
npm test -w @qbv/db
```

Env: `DATABASE_URL`, `DATABASE_POOL_MAX`, `DATABASE_SSL`, `ADMIN_EMAIL`,
`ADMIN_PASSWORD`, `ADMIN_NAME`, `TEST_DATABASE_URL`. See
[docs/configuration.md](../../docs/configuration.md).
