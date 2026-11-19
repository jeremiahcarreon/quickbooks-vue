# QuickBooks Vue

A modern web front end and an open integration API for QuickBooks Desktop
Enterprise.

- **Web app** (Vue 3): lists, transactions, Customer and Vendor Centers, a home
  dashboard, reports and a raw qbXML console. Forms are generated from the
  qbXML schema, so every entity the SDK exposes has list, detail, add and edit
  screens; the everyday transactions also have purpose-built forms.
- **Integration API**: any application can read and write the company file
  through a JSON REST API, or by sending raw qbXML that follows the Intuit
  schema.
- **Fast for many users**, even though QuickBooks handles one request at a
  time: reads come from a Postgres mirror of the company file, and writes are
  queued and sent to QuickBooks one by one.

**Every qbXML document that leaves the system is validated against the Intuit
XSD before it is sent.** A request QuickBooks cannot parse can drop the session
or open a modal dialog that blocks everything, so invalid XML is rejected
early: on build, before it is queued, in the worker before it is sent, and
optionally in the Windows relay itself. The raw qbXML endpoint answers 400 with
the libxml2 error and line number.

## Architecture

```
 Browser (Vue SPA)          Other apps
      │ REST + SSE              │ REST or raw qbXML (Bearer token)
      ▼                         ▼
 ┌──────────────┐   ┌───────────────────────────────┐
 │ web (nginx)  │──►│ api (Fastify)                 │──reads──►  Postgres
 │ SPA + /api   │   │ auth · RBAC · audit · reports │            read model, commands,
 └──────────────┘   └──────────────┬────────────────┘            audit, users
                                   │ enqueue (XSD-validated)          ▲
                                   ▼                                  │ write-through
             Redis: BullMQ "relay" queue + events ──────► worker (one at a time)
                   ▲                                                  │ HTTP + API key
                   │ enqueue queries                                  ▼
             sync (scheduler)                       relay (.NET, Windows) ──COM──► QuickBooks
                                                    or relay-mock in development
```

- **Reads** never touch QuickBooks; they come from the Postgres read model.
- **Writes** are commands: the api builds and validates the qbXML, queues it,
  and the single worker sends it through the relay. QuickBooks' answer is
  written back to the read model immediately and pushed to browsers over
  Server-Sent Events. A stale edit comes back as a conflict with a field diff.
- **Sync** keeps the read model current: initial load, incremental changes
  every minute, deletions, and a nightly reconcile. QuickBooks stays the
  source of truth; the read model can be rebuilt at any time.
- **Reports**: operational reports (aging, open invoices, balances, sales)
  run as SQL over the read model; financial statements and other QuickBooks
  reports are fetched from QuickBooks through the queue and cached.

The full design, contracts and decisions are in [docs/DESIGN.md](docs/DESIGN.md).

## Repository

| Path                                             | What it is                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [`apps/api`](apps/api)                           | REST API, SSE, raw qbXML endpoint, auth, RBAC, audit (Fastify)                                     |
| [`apps/worker`](apps/worker)                     | The only consumer of the relay queue; sends commands to QuickBooks                                 |
| [`apps/sync`](apps/sync)                         | Keeps the read model in step with QuickBooks                                                       |
| [`apps/web`](apps/web)                           | Vue 3 single-page app (PrimeVue)                                                                   |
| [`apps/relay-mock`](apps/relay-mock)             | Stateful, XSD-validating fake relay with a sample company, for development and tests               |
| [`packages/qbxml`](packages/qbxml)               | XSD loading and validation, schema catalog, build and parse                                        |
| [`packages/db`](packages/db)                     | Postgres schema, migrations, repositories                                                          |
| [`packages/queue`](packages/queue)               | Queue, priorities and event channel                                                                |
| [`packages/relay-client`](packages/relay-client) | HTTP client for the relay                                                                          |
| [`packages/config`](packages/config)             | Environment parsing and logging                                                                    |
| [`packages/reports`](packages/reports)           | SQL and QuickBooks reports                                                                         |
| [`server/`](server/)                             | The Windows relay: a .NET 8 service with an HTTP API in front of the QuickBooks SDK                |
| [`deploy/`](deploy)                              | Terraform for AWS, GCP and Azure, and the Helm chart                                               |
| [`e2e/`](e2e)                                    | Playwright end-to-end tests against the dev stack                                                  |
| [`docs/`](docs)                                  | [Design](docs/DESIGN.md), [configuration](docs/configuration.md), [operations](docs/ops/README.md) |

## Quick start (no QuickBooks needed)

Requirements: Docker with Compose, Node 22, and the qbXML 17.0 schema files.

1. **Schemas.** The Intuit XSDs are confidential and not in git. Copy
   `QBUqbxmlops170.xsd` and the files it includes from the QuickBooks SDK into
   `schemas/qbxml/17.0/` (or point `QBXML_SCHEMA_DIR` at them). Images built
   from this repository contain them, so never push those images to a public
   registry.

2. **Start the development stack** (Postgres, Redis, api, worker, sync, web and
   the relay mock seeded with a sample HVAC company):

   ```bash
   npm install
   npm run dev:up
   ```

3. **Open http://localhost:8180** and sign in as the first admin. The dev
   overlay creates it from `ADMIN_EMAIL` / `ADMIN_PASSWORD`, with
   development-only defaults listed in `compose.dev.yaml`. Set both
   variables before the first start to choose your own.

Sync loads the sample company within a few seconds. Then try:

- Lists and transactions under **Lists**, invoices and payments under
  **Customers**, bills and checks under **Vendors**.
- **Reports**: A/R aging straight from Postgres, or Profit & Loss from
  QuickBooks.
- **Admin → qbXML console**: write qbXML and see it checked against the XSD as
  you type.
- The API: OpenAPI docs at http://localhost:8180/api/docs (sign in to the web app
  first, or send an API token). For example, with an
  API token created under **Admin → API tokens**:

  ```bash
  curl -H "Authorization: Bearer $TOKEN" \
    'http://localhost:8180/api/objects/Invoice?filter[IsPaid]=false&sort=-txn_date'

  curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/xml' \
    --data-binary @customer-query.xml http://localhost:8180/api/qbxml
  ```

Dev ports (all on 127.0.0.1): web 8180, api 3100, relay mock 9223, Postgres
55434, Redis 56380. `npm run dev:logs` follows the logs; `npm run dev:down`
stops the stack. Every variable is documented in
[docs/configuration.md](docs/configuration.md).

## Production

In production the stack runs the same containers without the relay mock, and
`RELAY_URL` points at the Windows relay across a private network (WireGuard or
Tailscale); the relay is never exposed to the internet. Only the web container
is published, behind a TLS reverse proxy.

- Install the relay on the QuickBooks machine: [server/README.md](server/README.md).
- Deploy, network, TLS, backups, upgrades and troubleshooting:
  [docs/ops](docs/ops/README.md).
- Kubernetes on AWS, GCP or Azure (Terraform + Helm) and the CI/CD pipelines:
  [docs/ops/cloud.md](docs/ops/cloud.md).

## Development

```bash
npm run infra:up      # test Postgres (55433) and Redis (56379)
npm run build         # codegen from the XSDs, then every package and app
npm run typecheck
npm run lint
npm test              # unit and integration tests (vitest)
npm run test:e2e      # Playwright, against a running dev stack (npm run dev:up)
```

Build `@qbv/qbxml` before the packages that import it (`npm run build` does
this in order). Each app and package has its own README.

QuickBooks is a trademark of Intuit Inc. This project is not affiliated with or endorsed by Intuit.

## License

[MIT](LICENSE)
