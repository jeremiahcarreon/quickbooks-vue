# @qbv/relay-mock

A fake of the Windows relay (`server/`) for development and tests. It speaks
the relay's exact HTTP contract and behaves like a small QuickBooks company
file, so the whole stack runs on Linux without QuickBooks. Never use it in
production.

- **Every request is validated against the qbXML XSD** (libxml2 via
  `@qbv/qbxml`). Malformed XML gets the relay's own 502
  (`Malformed XML rejected before sending to QB: Line L, Position C: ...`).
  Well-formed but schema-invalid XML gets the 502 that QuickBooks' COM
  layer produces (`QuickBooks found an error when parsing the provided XML
text stream.`). The libxml2 detail goes to the log, to `GET /qb/errors`
  and to an `X-Mock-Validation-Error` response header.
- **Every response is XSD-valid.** Responses are built with
  `@qbv/qbxml` `buildResponse` (validated), and report responses are
  validated before they are sent.
- **Stateful and generic over the catalog.** Add, Mod, Query, ListDel,
  TxnDel and TxnVoid work for every entity in `catalog.entities`.
- **One request at a time**, with optional latency, as QuickBooks does.

## Run

```sh
npm run build -w @qbv/relay-mock
SEED=1 RELAY_API_KEY=dev-relay-key npm start -w @qbv/relay-mock   # http://localhost:9223
```

With Docker, `npm run dev:up` starts it from `compose.dev.yaml`. The
container listens on 9223 and is published on `127.0.0.1:${QBV_RELAY_MOCK_PORT:-9223}`.
The api and worker reach it at `http://relay-mock:9223`.

In tests of other workspaces:

```ts
import { startRelayMock } from '@qbv/relay-mock';

const relay = await startRelayMock({ seed: true, apiKey: 'k' }); // free port
// relay.url, relay.mock.engine, relay.mock.faults ...
await relay.close();
```

`new Engine()` plus `engine.processXml(xml)` runs requests in-process without HTTP.

## Configuration

| Variable                  | Default                        | Notes                                                                                                    |
| ------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `RELAY_MOCK_HOST`         | `0.0.0.0`                      |                                                                                                          |
| `RELAY_MOCK_PORT`         | `9223`                         |                                                                                                          |
| `RELAY_API_KEY`           | empty                          | Expected `X-Api-Key`. Empty means no key check, as on the relay.                                         |
| `MOCK_ALLOWED_IPS`        | empty                          | Comma-separated client IPs. Loopback is always allowed. Empty means no IP check.                         |
| `MOCK_LATENCY_MS`         | `0`                            | Simulated QuickBooks time per request                                                                    |
| `MOCK_LATENCY_JITTER_MS`  | `0`                            | Random extra latency, from 0 up to this value                                                            |
| `MOCK_REQUEST_TIMEOUT_MS` | `120s`                         | The relay-side timeout that the `timeout` fault simulates                                                |
| `SEED`                    | `false`                        | `1` loads the sample company when the store is empty                                                     |
| `MOCK_SEED_ANCHOR`        | `2026-10-31`                   | Date of the last sample transaction: `YYYY-MM-DD` or `today`                                             |
| `MOCK_DATA_FILE`          | unset                          | JSON file. Loaded at start and saved about 200 ms after each write. Unset keeps the data in memory only. |
| `MOCK_COMPANY_NAME`       | `Summit Air Heating & Cooling` | Returned by `CompanyQuery`                                                                               |
| `QBXML_SCHEMA_DIR`        | `<repo>/schemas/qbxml/17.0`    | Location of the XSDs                                                                                     |
| `LOG_LEVEL`, `LOG_PRETTY` | `info`, `false`                | pino logging                                                                                             |

Compose (`apps/relay-mock/compose.yaml`) maps `RELAY_MOCK_SEED`,
`RELAY_MOCK_SEED_ANCHOR`, `RELAY_MOCK_LATENCY_MS`, `RELAY_MOCK_LATENCY_JITTER_MS`
and `RELAY_MOCK_DATA_FILE` onto these variables. In Compose the company is kept
in `/app/data/relay-mock-company.json` on the `relaymock` volume, so restarts
and image rebuilds keep it (and the read model stays in step). Set
`RELAY_MOCK_DATA_FILE=` (empty) for a fresh, reseeded company on every start,
then resync with `POST /api/admin/sync/*` `{"mode":"full"}`; `docker compose
down -v` removes the volume.

## HTTP

The relay contract, as described in `server/README.md`:

| Route              | Behaviour                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /qb/request` | `{qbxml}` → `200 {response, error: null}`. Error statuses: 400 (missing `qbxml`), 401, 403, 502 (malformed, rejected or COM error), 503, 504. |
| `GET /qb/health`   | `{connected, lastError, lastRequestTime, uptime}`                                                                                             |
| `POST /qb/restart` | `{restarted: true}`; clears a `disconnected` fault                                                                                            |
| `GET /qb/errors`   | The recent error log as text, in the relay's `qb-errors.log` format                                                                           |

The IP check runs first, then the `X-Api-Key` check. Both apply to every route.

Control endpoints for tests. These are not part of the relay, and the same
key applies:

| Route                                   | Body / effect                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /mock/faults`                     | `{mode, count?, delayMs?, message?}`. `count` is the number of requests affected (default 1; 0 means until cleared). Modes are listed below. |
| `GET` / `DELETE /mock/faults`           | List or clear the faults                                                                                                                     |
| `PUT /mock/latency`                     | `{ms, jitterMs?}`                                                                                                                            |
| `PUT /mock/clock`                       | `{now: ISO}` shifts the mock's clock; `{now: null}` resets it                                                                                |
| `POST /mock/reset`                      | `{seed?: boolean, anchor?}` empties the company file, and reseeds it if `seed` is set                                                        |
| `GET /mock/state`                       | Object counts, iterators, faults, latency, clock                                                                                             |
| `GET /mock/requests`                    | The last 200 requests (Rq names, status codes, duration)                                                                                     |
| `GET /mock/export`, `POST /mock/import` | Snapshot of the whole store, or replace the store with one                                                                                   |

Fault modes:

- `disconnected`: 503, and health reports `connected: false`.
- `timeout`: holds the request for `delayMs` (default the request timeout), then answers 504 with the relay's message.
- `error`: 502 with a COM error message.
- `drop`: closes the connection without a response.
- `executeThenTimeout`: processes the request, then answers 504. Use it to test calls that may have executed.
- `garbage`: 200 with a truncated response document.

## Behaviour

- **IDs.**
  - ListIDs look like `80000001-1700000000` and TxnIDs and TxnLineIDs like `1A-1700000000`: a counter plus the creation time in seconds.
  - `EditSequence` is the modification time in seconds and always increases.
  - `TimeCreated` and `TimeModified` are local time with offset.
- **Mod.**
  - A stale `EditSequence` gets 3200. A missing object gets 3120.
  - Line Mods follow QuickBooks: `TxnLineID` `-1` adds a line, an existing id updates that line, and lines left out are removed. `JournalLineMod` lines are split by `JournalLineType`.
- **Lists.**
  - Customer, Vendor, Employee and OtherName share one name space. All item types share another, and the two terms lists share a third. A duplicate name gets 3100.
  - Hierarchical lists get `FullName` and `Sublevel`. A rename or move cascades to the children and bumps their `TimeModified`.
  - A dangling `*Ref` gets 3140.
  - `ListDel` of an object that is still referenced gets 3170.
- **Queries.**
  - ListID, TxnID and FullName lists. A missing id gets 500 (Warn) and the objects that were found.
  - `RefNumber` and `RefNumberCaseSensitive`, `MaxReturned`, and `ActiveStatus` (default `ActiveOnly`).
  - Modified-date filters: `FromModifiedDate`/`ToModifiedDate` and `ModifiedDateRangeFilter`.
  - `TxnDateRangeFilter` (dates or `DateMacro`), `EntityFilter` and `AccountFilter` (including the `WithChildren` forms).
  - `RefNumberFilter`/`RefNumberRangeFilter`, `NameFilter`/`NameRangeFilter`, `AccountType`, `PaidStatus` and `TotalBalanceFilter`.
  - `IncludeLineItems` (lines are left out by default), `IncludeLinkedTxns` and `IncludeRetElement`.
  - An empty result gets status 1, "A query request did not find a matching object in QuickBooks".
  - Iterators: `Start`, `Continue` and `Stop`, with `iteratorRemainingCount`. An unknown iterator gets 3000.
  - Union queries: `ItemQuery`, `EntityQuery`, `TermsQuery` and `PayrollItemQuery`.
  - Also supported: `TransactionQuery`, `ListDeletedQuery`/`TxnDeletedQuery` (fed by deletes), `ReceivePaymentToDepositQuery` and `BillToPayQuery`.
  - `HostQuery`, `CompanyQuery` and `PreferencesQuery` always answer.
- **Transactions.**
  - Line `Amount` is Quantity × Rate, and the item's price or cost is used when no rate is given. Discount and subtotal items work, and item groups expand from their definition.
  - Sales tax comes from the taxable lines and the `ItemSalesTaxRef` rate, falling back to the customer's.
  - Totals: `Subtotal`, `TotalAmount`, `AmountDue`, `Amount`, `DepositTotal` and `CreditRemaining`. QuickBooks' defaults are filled: RefNumber auto-numbering for sales forms, A/R and A/P accounts, Undeposited Funds, terms and due dates.
  - `ReceivePayment` applies to invoices (explicitly or `IsAutoApply`) and reduces their `BalanceRemaining`. The invoice's `IsPaid`, `AppliedAmount` and `LinkedTxn` are updated, and its `TimeModified` and `EditSequence` are bumped so incremental sync picks it up. Bill payments do the same for bills.
  - Overpaying or paying another customer's invoice gets 3180. An unbalanced journal entry also gets 3180.
  - Deposits take payments out of Undeposited Funds.
  - Void zeroes the amounts and prefixes the memo with `VOID:`. A transaction with payments applied cannot be voided or deleted.
- **Batches.** `requestID` is echoed. `stopOnError` stops at the first error, `continueOnError` runs every request, and `rollbackOnError` also undoes the earlier requests. Each request on its own is atomic.
- **Reports.** These are computed from a general ledger derived from the transactions:
  - `GeneralSummaryReportQuery`: `ProfitAndLossStandard`, `BalanceSheetStandard`/`Summary`, `TrialBalance`, `CustomerBalanceSummary` and `VendorBalanceSummary`.
  - `AgingReportQuery`: `ARAgingSummary`/`Detail`, `APAgingSummary`/`Detail` and `CollectionsReport`.
  - They use QuickBooks' `ReportRet` shape: interleaved Text/Data/Subtotal/Total rows, `ColDesc` and `rowNumber`.
  - `ReportPeriod` and `ReportDateMacro` are honoured.
  - Other report types get 3250 ("feature not available").
- **Balances.** Customer and vendor `Balance`/`TotalBalance` and account `Balance` are computed when objects are returned. Ref `FullName`s always show the current names.
- **Seed data.** `SEED=1` creates a deterministic small HVAC service company, using the same seed every time:
  - About 43 accounts, items of every kind, about 37 customers and jobs, 12 vendors, 6 employees, terms, classes, sales tax and payment methods.
  - About 250 transactions over the year before `MOCK_SEED_ANCHOR`: invoices, payments, deposits, sales receipts, bills, bill payments, checks, card charges, journal entries, estimates, sales and purchase orders, credit memos and transfers.
  - Every object is created by sending a validated qbXML request through the engine.

Not modelled: inventory quantities on hand, credit memo application, multi-currency,
and report types other than those listed.
