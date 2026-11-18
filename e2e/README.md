# @qbv/e2e

Playwright end-to-end tests that drive the whole stack: browser, nginx, api,
Redis queue, worker, relay mock, sync and Postgres.

```bash
npm run dev:up                      # compose.yaml + compose.dev.yaml, relay mock seeded
npx playwright install chromium     # once
npm run test:e2e                    # from the repo root
```

The tests run serially (one QuickBooks, one read model) and leave their
records in the company with a per-run suffix, so they can be repeated against
the same stack.

| Spec              | Covers                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-sync`         | Full resync through `POST /api/admin/sync/*`; every sync unit `ok`; every object type in the relay mock has the same number of live rows in Postgres |
| `02-auth`         | Login redirect, wrong password, sign in, session survives reload                                                                                     |
| `03-list-entity`  | Generic screens on Customer: list, search, add, detail, edit, delete                                                                                 |
| `04-conflict`     | A stale edit becomes a 3200 conflict with a field diff; "Reload and reapply" saves it                                                                |
| `05-transaction`  | Invoice form: add with a line, edit (InvoiceMod), void and delete from the detail screen                                                             |
| `06-qbxml`        | `POST /api/qbxml`: 400 with the libxml2 error for invalid XML, QuickBooks' response for valid XML; console live XSD check                            |
| `07-reports`      | Report catalog, an SQL report, a QuickBooks P&L through the queue, cache and refresh                                                                 |
| `08-live-updates` | SSE events reach the browser; an open list refreshes by itself                                                                                       |
| `99-xsd-audit`    | Every command created during the run carries XSD-valid qbXML, and the relay mock logged no rejection                                                 |

Variables (see docs/configuration.md): `E2E_BASE_URL` (default
`http://localhost:8180`; the Vite dev server `http://127.0.0.1:5273` also
works), `E2E_RELAY_MOCK_URL` (`http://127.0.0.1:9223`), `E2E_ADMIN_EMAIL` /
`E2E_ADMIN_PASSWORD` (fall back to `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then to
the dev overlay defaults) and `RELAY_API_KEY` (`dev-relay-key`).

The XSD audit imports `@qbv/qbxml`, so build it first (`npm run build`).
Failures keep a trace and screenshot in `test-results/`
(`npx playwright show-trace <trace.zip>`).
