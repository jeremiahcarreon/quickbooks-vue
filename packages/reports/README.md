# @qbv/reports

Report definitions for QuickBooks Vue (DESIGN section 6.7). Two kinds, one
output shape:

- **SQL operational reports** run over the `qb_object` read model. They are
  instant, never touch QuickBooks, and can be run by any permitted user at any time.
- **QuickBooks reports** cover every report type the qbXML 17.0 schema offers. They are
  built with `@qbv/qbxml`, so every request is **schema-ordered and validated against
  the XSD before it is queued**. They are sent through the relay queue at priority 8
  (`Priority.ReportFetch`) and cached in `report_cache`.

Both kinds return a normalized `ReportResult`:

```ts
{
  columns: { key, title, titles?, type: 'text'|'date'|'amount'|'price'|'quantity'|'percent'|'number'|..., qbType? }[],
  rows:    { kind: 'data'|'text'|'subtotal'|'total', indent, label?, cells: {[key]: string|number|boolean|null},
             rowType?, rowValue?, ref?: { type, id } }[],
  totals:  {[key]: value} | null,      // grand total row
  meta:    { name, title, subtitle?, source: 'sql'|'qb', params, generatedAt, basis?,
             fetchedAt?, expiresAt?, cached?, commandId?, rowCount, notes? }
}
```

## HTTP routes

```ts
import { registerReportRoutes, reportRoutes } from '@qbv/reports';

await app.register(
  async (scope) =>
    registerReportRoutes(scope, {
      db, // Kysely (@qbv/db)
      queue, // relay queue (@qbv/queue); without it QB reports answer 503
      events, // optional event bus: faster wake-up than DB polling
      cacheTtlMs: config.REPORT_CACHE_TTL, // default 15 min
      waitMs: 20_000, // how long a request waits for QuickBooks before answering 202
      getPermissions: (req) => req.auth?.permissions, // default: request.auth|user.permissions
      getActor: (req) => ({ actorType: 'user', actorId: req.auth.userId }),
    }),
  { prefix: '/api' },
);
// or: app.register(reportRoutes, { prefix: '/api', ...deps })
```

| Route                | Result                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /reports`       | `{ reports: ReportDefinitionInfo[], categories }`, with only the reports the caller may run              |
| `GET /reports/:name` | `200 { status: 'ready', ...ReportResult }`, or `202 { status: 'pending', commandId }` with `Retry-After` |
| `...?format=csv`     | `text/csv` attachment                                                                                    |

Report parameters are passed in the query string. Repeated keys and
comma-separated values both work for lists. The reserved parameters are:

- `refresh=true`: skip the cache and fetch again from QuickBooks.
- `commandId=<id>`: continue a report that came back `pending`.
- `wait=<ms>`: how long to wait for QuickBooks, capped by `maxWaitMs` (60s).
- `format=json|csv`.

Permissions: `report:<name>` (for example `report:ar-aging-summary` or
`report:GeneralSummary.ProfitAndLossStandard`). `report:*` and `admin`
grant every report.

Errors use `{ error: { code, message, details? } }`:

| Status | Code                | When                                                               |
| ------ | ------------------- | ------------------------------------------------------------------ |
| 400    | `invalid_params`    | `details` lists every bad parameter                                |
| 401    | `unauthorized`      |                                                                    |
| 403    | `forbidden`         |                                                                    |
| 404    | `not_found`         |                                                                    |
| 502    | `qb_error`          | QuickBooks returned an error status; `details.statusCode` holds it |
| 503    | `queue_unavailable` | No relay queue was given                                           |
| 500    | `qbxml_invalid`     | A built request failed XSD validation, which should never happen   |

## SQL reports

| Name                           | What it shows                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `ar-aging-summary` / `-detail` | Open invoices, statement charges, credit memos and unapplied payments, bucketed by days past due (`asOf`, `interval`) |
| `ap-aging-summary` / `-detail` | Open bills and unapplied vendor credits                                                                               |
| `open-invoices`                | Invoices and charges with a balance, by customer                                                                      |
| `unpaid-bills`                 | Bills with an open amount, by vendor                                                                                  |
| `open-sales-orders`            | Sales orders that are not fully invoiced and not closed                                                               |
| `open-purchase-orders`         | Purchase orders that are not fully received and not closed                                                            |
| `customer-balance-summary`     | Customer list balances, with jobs indented                                                                            |
| `customer-balance-detail`      | A/R transactions with a running balance (an opening balance when `from` is set)                                       |
| `vendor-balance-summary`       | Vendor list balances                                                                                                  |
| `vendor-balance-detail`        | Bills, credits and bill payments with a running balance                                                               |
| `sales-by-customer-summary`    | Invoice and sales receipt subtotals minus credit memos                                                                |
| `sales-by-item-summary`        | Quantity and amount by item, from transaction lines including group lines                                             |
| `purchases-by-vendor-summary`  | Bills, item receipts, checks and card charges minus credits, for vendors only                                         |
| `transaction-list-by-date`     | Every transaction in the period (optional `txnType` filter)                                                           |
| `inventory-valuation-summary`  | On hand × average cost and × sales price, with % of total                                                             |

Periods accept `from`/`to`, or `dateMacro`, which takes any QuickBooks `ReportDateMacro`
and is resolved locally: weeks start on Sunday and years are calendar years.
These reports use the read model's current balances, so the aging reports measure
age to the as-of date but do not rebuild balances as they stood on a past date.
For that, use the QuickBooks `Aging.*` reports. Pending transactions and
soft-deleted rows are excluded.

## QuickBooks reports

`qbReportDefinitions()` makes one report for each value of each `*ReportType`
enum on every `*ReportQueryRq` in the catalog: General Summary/Detail, Aging,
Budget Summary, Custom Summary/Detail, Job, Payroll Summary/Detail and Time.
That is 93 reports. The schema also lists an empty `JobReportType` value, which
is not offered as a report. Names are `<Kind>.<ReportType>`, for example
`GeneralSummary.ProfitAndLossStandard` or `Aging.ARAgingDetail`.

Parameters come from the request's schema fields:

- `from`/`to` map to `ReportPeriod`, and `dateMacro` to `ReportDateMacro`.
- `account`/`accountType`, `entity`/`entityType`, `item`/`itemType` and `class`
  map to the `Report*Filter`s. A type wins over a list of names.
- `txnType` maps to `ReportTxnTypeFilter`, and `modifiedFrom`/`modifiedTo`/`modifiedMacro`
  to the modified-date filter.
- Every other simple element (`ReportBasis`, `SummarizeColumnsBy`, `IncludeColumn`, ...)
  is a parameter with the element's own name.

Fields the schema requires get defaults: `FiscalYear` is the current year,
`SummarizeColumnsBy` is `TotalOnly`, `SummarizeRowsBy` is `Account`, and
`IncludeColumn` is a standard column list.

Flow:

1. Look in the cache. The key is the report name plus its parameters, plus the
   current day for relative dates.
2. If an identical request is already queued or running, join it.
3. Otherwise build and validate the request, then call `enqueueCommand(kind: 'report')`.
4. Wait up to `waitMs`, then parse `command.response_xml`.
5. Normalize `ReportRet`. Rows are put back in `rowNumber` order. Text rows open
   a level, subtotal rows close one, and the last `TotalRow` becomes `totals`.
6. Store the result in `report_cache`.

A command that finishes after its caller stopped waiting still fills the
cache on the next request.

## Development

```sh
npm run infra:up                  # Postgres 127.0.0.1:55433 + Redis 127.0.0.1:56379
npm run build -w @qbv/qbxml -w @qbv/config -w @qbv/db -w @qbv/queue
npm run build|typecheck|lint|test -w @qbv/reports
```

The tests check XSD validity of a request for **every** report-type enum value:
with defaults, with dates, with every parameter set, and with every date macro.
They also check that every QuickBooks-style response they use is XSD-valid, run
every SQL report against fixtures on a throwaway database, and drive QuickBooks
reports end to end through BullMQ with a stand-in worker. That worker rejects
any request that is not XSD-valid.

Env (see `docs/configuration.md`): `REPORT_CACHE_TTL` (default `15m`) is read by
the api and passed as `cacheTtlMs`. Tests use `TEST_DATABASE_URL`,
`TEST_REDIS_URL` and `QBXML_SCHEMA_DIR`.
