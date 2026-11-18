# @qbv/sync

Keeps the Postgres read model (`qb_object`) in step with QuickBooks
(docs/DESIGN.md §6.8). It never talks to the relay itself: every query is an
XSD-validated `query` command on the relay queue, which the worker sends. Sync
then waits for the command and reads its `response_xml`.

```sh
npm run build -w @qbv/sync
npm start -w @qbv/sync          # node dist/main.js
npm test -w @qbv/sync           # needs `npm run infra:up` and the XSDs
```

## What runs when

The plan comes from `catalog.entities` (`planSync()`):

- A **unit** is one query request. Every entity with its own query op gets one.
- Entities that only come back from a union query (`PayrollItemTax`,
  `PayrollItemAddition`, ... via `PayrollItemQueryRq`) share one unit, and
  their Rets are sorted by Ret element name.
- Queries with required elements (`BillToPay`, `SalesTaxReturnLine`, the
  subscription queries, ...) and `DataExt` are skipped. Each skip records a
  reason.
- `SYNC_ENTITIES` limits the plan.

| Step          | When                                                              | Priority | Query                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial load  | first pass for a unit with a modified filter (or a manual `full`) | 10       | full query, iterator `Start`/`Continue`, `MaxReturned` = `SYNC_PAGE_SIZE`                                                                                                                                                                      |
| Incremental   | every `SYNC_INTERVAL`                                             | 5        | `FromModifiedDate` (lists) or `ModifiedDateRangeFilter/FromModifiedDate` (txns) = cursor minus `SYNC_OVERLAP`                                                                                                                                  |
| Deletions     | every `SYNC_INTERVAL`, before incrementals                        | 5        | one `ListDeletedQueryRq` and one `TxnDeletedQueryRq` with every loaded unit's `ListDelType`/`TxnDelType`, `DeletedDateRangeFilter` from the oldest cursor minus the overlap (left out when that is older than QuickBooks keeps, about 90 days) |
| Full re-query | every `SYNC_FULL_INTERVAL`                                        | 10       | units without a modified filter (`Template`, `Company`, `Preferences`, `ItemSites`, ...)                                                                                                                                                       |
| Reconcile     | `SYNC_RECONCILE_CRON`                                             | 10       | ID-only query (`IncludeRetElement` ListID/TxnID, EditSequence, TimeModified). Rows that are missing locally or have a different EditSequence are fetched by id in batches of 100. Local rows that QuickBooks no longer has are soft-deleted.   |

Query details, all derived from the schema:

- Only elements the request defines are sent.
- Choice groups are respected: a wanted element in a conflicting `xsd:choice`
  branch is dropped (`selectFields`), never sent.
- Lists ask for `ActiveStatus All` and ToDos for `DoneStatus All`.
- Transactions ask for `IncludeLineItems` (`IncludeComponentLineItems` for
  `BuildAssembly`), plus `OwnerID 0` for public custom fields.
- `MaxReturned` and iterators are used only when the query supports both. A
  `MaxReturned` without an iterator would truncate the result.
- A failed `Continue` (for example the iterator expired because the relay
  restarted) restarts the load once.

**Cursor.** The cursor is the newest `TimeModified` QuickBooks returned, so it
follows QuickBooks' clock. A full load that returns nothing starts from its own
start time.

**Missing rows.** After a full load or a reconcile, rows that were not returned
are soft-deleted, but only if they were last written before the run started.
That keeps a write-through by the worker during a long load.

**Status.** Status goes to `sync_state`, one row per entity: status
`loading|running|reconciling|ok|error|idle`, `error`, `row_count`,
`last_modified_cursor`, `last_full_sync_at`, `last_reconcile_at`. Progress is
published as `sync.progress` (`running`, `ok`, `reconciled`, `error`). Changes
are published as `object.changed` (`sync`/`del`) for small incremental pages.

**Failures.** A failing unit backs off exponentially, from the interval up to
1 h, and doesn't stop the others. Each unit waits for its own commands, so
when the relay is down sync simply waits (up to `SYNC_COMMAND_TIMEOUT` per
command) instead of piling up work.

## One instance at a time

A Redis lock `<QUEUE_PREFIX>:sync:leader` (`SET NX PX`, renewed every TTL/3
with a compare-and-renew script) elects the leader. Only the leader schedules.
A standby takes over within `SYNC_LOCK_TTL` when the leader stops or dies. On
losing the lock the current pass is aborted.

## Manual trigger (POST /admin/sync/:type)

Requests go on a Redis list. The leader drains it about once a second, and also
between passes. Requests made while no sync is running are kept.

```ts
import { requestSync } from '@qbv/sync';
await requestSync(
  redis,
  { type: 'Customer', mode: 'full', requestedBy: user.id },
  { prefix: config.QUEUE_PREFIX },
);
```

Equivalent raw form:

```
RPUSH <QUEUE_PREFIX>:sync:requests '{"type":"Customer","mode":"full","requestedBy":"<user id>"}'
```

- `type`: an entity name (a union-only entity selects its union unit), or `*`
  for everything.
- `mode`:
  - `incremental` (default): changes now, or an initial load if the type was
    never loaded.
  - `full`: forget the cursor and reload everything at priority 10.
  - `reconcile`: the ID-only check now.

Unknown types are logged and ignored. Results show up in `sync_state` and as
`sync.progress` events.

## Seams with other services

- Sync commands carry `payload.writeThrough = false` and `payload.sync =
{phase, unit}`. Sync stores the Rets itself. Reconcile asks for id-only Rets,
  which must never overwrite full rows, so the worker should skip write-through
  for these commands.
- After a sync command has been processed, its `response_xml` is cleared and
  `result` is set to `{pruned, statusCode, retCount, iteratorRemainingCount}`
  (`SYNC_PRUNE_RESPONSES=false` keeps the XML).
- A `failed` command that still has a response is read as QuickBooks' answer.
  Status 1 ("no match") counts as an empty success.

## Configuration

From `@qbv/config` (`loadConfig('sync')`, see docs/configuration.md):
`DATABASE_URL`, `DATABASE_POOL_MAX`, `DATABASE_SSL`, `REDIS_URL`,
`QUEUE_PREFIX`, `QBXML_VERSION`, `QBXML_SCHEMA_DIR`, `SYNC_ENABLED`,
`SYNC_INTERVAL` (60s), `SYNC_FULL_INTERVAL` (1h), `SYNC_PAGE_SIZE` (500),
`SYNC_RECONCILE_CRON` (`0 3 * * *`), `SYNC_ENTITIES`.

Read by this service only (defaults in brackets):

| Variable                     | Default | Purpose                                                                                        |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `SYNC_OVERLAP`               | `1m`    | Subtracted from the cursor on each incremental and deleted query. A bare number means seconds. |
| `SYNC_COMMAND_TIMEOUT`       | `30m`   | Longest wait for one command, including queue time                                             |
| `SYNC_PRUNE_RESPONSES`       | `true`  | Clear `response_xml` of processed sync commands                                                |
| `SYNC_INCLUDE_CUSTOM_FIELDS` | `true`  | Send `OwnerID 0` so Rets include public custom fields                                          |
| `SYNC_LOCK_TTL`              | `30s`   | Leader lock lifetime                                                                           |
| `TZ`                         | system  | Time zone for `SYNC_RECONCILE_CRON`                                                            |

The cron syntax has five fields and supports `*`, lists, ranges and steps.

## Tests

- `test/queries.test.ts` generates the initial (Start and Continue),
  incremental, deleted, reconcile and fetch-by-id request for every entity in
  the plan and validates each one against the XSD. It also checks plan coverage
  and choice-group handling.
- `test/engine.test.ts` runs the real queue, Postgres and Redis with a stand-in
  worker and an in-memory QuickBooks. That QuickBooks validates every request
  and answers with `buildResponse` output. The test covers initial paging,
  incremental, deletions, reconcile, full re-query, iterator restart, QB
  errors, the scheduler and the leader lock.
- `test/service.test.ts` checks the wiring, leader handover and a manual
  request through the running loop.
