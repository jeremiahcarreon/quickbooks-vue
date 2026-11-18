# Transactions, centers and home

Three web modules, each registered through `src/modules/<name>/index.ts`:

| Module         | Routes                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| `transactions` | `/transactions` (all forms), `/transactions/<slug>/new`, `/transactions/<slug>/<TxnID>` |
| `centers`      | `/centers/customers/:id?`, `/centers/vendors/:id?`                                      |
| `home`         | `/` (dashboard)                                                                         |

## Forms

Spec-driven (`lib/specs.ts`, rendered by `views/TxnFormView.vue`): invoice,
sales-receipt, estimate, sales-order, credit-memo, statement-charge, bill,
check, purchase-order, item-receipt, vendor-credit, credit-card-charge,
credit-card-credit, transfer. Purpose-built views: receive-payment, pay-bills,
journal-entry, deposit.

Each form:

- lays out a header block, a line grid and a totals footer like QuickBooks
  Desktop. Keys: `Ctrl+S`/`Alt+S` save, `Alt+N` save & new, `Enter`/arrows move
  between lines, `Ctrl+Insert`/`Ctrl+Delete` insert/delete a line;
- reads lengths and enums from `GET /api/meta/entities/:type` (any envelope
  holding `{name, fields}` object definitions), falling back to the spec;
- uses type-ahead ref pickers over `GET /api/objects/:type?q=` (items search
  every item type; accounts are filtered by `AccountType`);
- computes line amounts, tax and totals client-side with exact decimal
  arithmetic (`lib/decimal.ts`, bigint). These are for display; QuickBooks is
  authoritative;
- submits element-named JSON in catalog order: `POST /api/objects/<Type>` for
  Add, `PATCH /api/objects/<Type>/<TxnID>` with `TxnID` + `EditSequence` for
  Mod (lines keep their `TxnLineID`, new lines use `-1`);
- follows the command (`GET /api/commands/:id`): pending, then confirmed,
  failed (QuickBooks status code and message, or the API's schema-validation
  error) or conflict (field diff with "reload & reapply").

Transactions that contain item-group lines open read-only, because a Mod
without the group lines would delete them.

## qbXML schema validation

The API builds and XSD-validates the qbXML. The tests make sure the bodies
these forms produce are valid: `__tests__/xsd.test.ts` runs in the node
environment, builds a typical Add and Mod for every form with
`@qbv/qbxml` `buildRequest()`, asserts `validate()` passes against the Intuit
XSD, and checks every key is a catalog field in catalog order. It needs the
XSDs in `schemas/qbxml/17.0/` (or `QBXML_SCHEMA_DIR`) and a built
`@qbv/qbxml`.

## Tests

```sh
npm test -w @qbv/web                                         # whole app
npx vitest run --config src/modules/transactions/vitest.config.ts   # these modules only (from apps/web)
```

No environment variables are used by these modules.
