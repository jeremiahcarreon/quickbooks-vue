# @qbv/web

Vue 3 + Vite + TypeScript + Pinia + vue-router + PrimeVue 4 (Aura).

```sh
npm run dev -w @qbv/web        # http://127.0.0.1:5273, /api proxied to VITE_API_PROXY (default http://127.0.0.1:3100)
npm run build -w @qbv/web      # type-check + production build to dist/
npm run typecheck -w @qbv/web
npm run lint -w @qbv/web
npm test -w @qbv/web           # vitest (jsdom); the form tests also validate against the XSD
```

`@qbv/qbxml` must be built first (`npm run build -w @qbv/qbxml`) because the
form tests turn generated form bodies into qbXML with `buildRequest()` and
validate it against the Intuit XSD. The XSDs never reach the browser: in the
app, qbXML is only built and validated on the server.

## Structure

| Path                            | What                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`, `src/plugins.ts` | Bootstrap: Pinia, router (+ auth guard), PrimeVue, Toast, Confirm, 401 handling                               |
| `src/layouts/AppShell.vue`      | Top bar (global search, relay status, command tray, user menu) + sidebar from module nav                      |
| `src/api/client.ts`             | `api.get/post/patch/put/del`, CSRF header, `ApiError`, `buildQuery()`                                         |
| `src/api/endpoints.ts`          | Typed wrappers: `authApi`, `metaApi`, `objectsApi`, `commandsApi`, `qbxmlApi`, `adminApi`, `fetchHealth`      |
| `src/api/normalize.ts`          | Accepts snake_case rows or camelCase from the API                                                             |
| `src/stores/`                   | `useAuthStore`, `useEventsStore` (SSE), `useCommandsStore` (tray), `useMetaStore` (catalog), `useDraftsStore` |
| `src/forms/model.ts`            | Pure metadata-driven form model (describe, validate, serialise, Mod diff, reapply, server error mapping)      |
| `src/components/`               | Shared components (below)                                                                                     |
| `src/modules/entities`          | Generic list / detail / add / edit screens for every catalog entity                                           |
| `src/modules/admin`             | Users, roles, API tokens, sync status, command history, raw qbXML console                                     |
| `src/modules/<name>/index.ts`   | Feature modules, collected by `src/modules/registry.ts`                                                       |

### Modules

`src/modules/<name>/index.ts` exports `routes` (RouteRecordRaw[]) and `nav`
(NavItem[]: `label`, `to`, `area`, `icon`, `order`, `permission`), or a
default export of that shape. Areas: Home, Customers, Vendors, Employees,
Banking, Company, Lists, Reports, Admin. Routes render inside the shell. A
placeholder home page is used until a module registers path `/`.

Route `meta`: `{ permission?: string }` (checked by the guard; users without it
see "Not allowed"), `{ public: true }` for pages that need no login.

Nav items with a `permission` are hidden from users who lack it.

## Shared components (`src/components`)

Import with `@/components/<Name>.vue`. All values use the qbXML JS shape:
element names as keys, leaf values as strings, refs as `{ ListID?, FullName? }`.

### `QbDataTable` - server-side list of one entity

```vue
<QbDataTable
  entity="Invoice"
  :columns="[
    { field: 'ref_number', header: 'No.' },
    { field: 'name', header: 'Customer' },
    { field: 'txn_date', header: 'Date', kind: 'date' },
    { field: 'amount', header: 'Total', kind: 'money' },
    { field: 'BalanceRemaining', header: 'Balance', kind: 'money' },
  ]"
  :filter="{ IsPaid: 'eq:false' }"
  v-model:q="search"
  state-key="invoices"
  @row-click="(row) => router.push(`/invoices/${row.id}`)"
>
  <template #cell-amount="{ row, value }">...</template>
</QbDataTable>
```

Props: `entity` (required); `columns?: ColumnSpec[]` (default: name / ref /
date / amount / active for the entity category); `filter?: Record<string,string>`
(fixed `filter[field]=op:value`; ops eq, ne, lt, lte, gt, gte, like, in,
isnull, notnull); `q?` (full-text, `v-model:q`); `pageSize?` (default 50);
`includeInactive?`; `columnChooser?` (default true: users can add any Ret field);
`stateKey?` (remembers chosen columns, sort and page size per browser);
`defaultSort?` (`'-txn_date'`). `ColumnSpec`: `{ field, header?, kind?: 'text'|'money'|'date'|'bool'|'ref', sortable? }`.
`field` is a read-model column (`name`, `ref_number`, `txn_date`, `amount`,
`is_active`, `time_modified`) or a Ret path (`CustomerRef`, `BillAddress.City`).
Emits `row-click(row: QbObject)`, `loaded(page)`. Slots `#cell-<field>`,
`#toolbar`. Exposes `reload()`. Reloads itself on `object.changed` for the
entity and shows `PendingBadge`s for rows with an in-flight command, plus
optimistic rows for pending adds.

### `RefPicker` - pick a list object

```vue
<RefPicker v-model="form.CustomerRef" entity="Customer" @select="(row) => onCustomer(row)" />
<RefPicker v-model="line.ItemRef" :entity="['ItemService', 'ItemInventory', 'ItemNonInventory']" />
```

Props: `modelValue: { ListID?, FullName? } | null`; `entity: string | string[]`
(searched in parallel with `GET /api/objects/<entity>?q=`); `placeholder?`,
`disabled?`, `invalid?`, `filter?` (extra `filter[...]`), `allowFreeText?`
(default true: an unknown name is sent as `FullName` only). Emits
`update:modelValue` and `select(row: QbObject | null)` with the full row (use it
to default rates, terms, addresses).

### `MoneyInput` - AMTTYPE / PRICETYPE / QUANTYPE / PERCENTTYPE

`<MoneyInput v-model="line.Rate" kind="price" />`. `modelValue: string | null`
(exact decimal string, never a float); `kind: 'amount' | 'price' | 'quantity' |
'percent' | 'float' | 'integer'` (default amount: 2 decimals; price/quantity/percent
up to 5); `currency?: boolean` (prefix `$`, amount only), `invalid?`,
`disabled?`, `placeholder?`.

### `DateInput` - DATETYPE / DATETIMETYPE

`<DateInput v-model="form.TxnDate" />`. `modelValue: string | null`
(`YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm:ss` with `with-time`), `invalid?`,
`disabled?`.

### `LineItemsEditor` - repeating complex field

```vue
<LineItemsEditor
  v-model="form.InvoiceLineAdd"
  object="InvoiceLineAdd"
  :columns="['ItemRef', 'Desc', 'Quantity', 'Rate', 'Amount']"
  :errors="errors"
  path="InvoiceLineAdd"
  @line-change="({ index, field, line }) => recalc(line)"
/>
```

Props: `modelValue: Record<string, unknown>[]`; `object` (ObjectDef name; the
definition must be loaded into the meta store, e.g. `meta.loadEntity('Invoice')`);
`columns?` (fields shown inline; default the first few simple/ref fields), the
rest open in a row expander; `errors?` + `path?` (error map from
`validateValue`, keys like `InvoiceLineAdd[0].Rate`); `owner?` (entity, for
ParentRef); `disabled?`; `minRows?`. Emits `update:modelValue`,
`line-change({ index, field, value, line })`. Slots `#cell-<field>="{ line, index }"`,
`#footer`.

### `PendingBadge`

`<PendingBadge entity="Invoice" :id="row.id" />` looks up the commands store;
or `<PendingBadge status="conflict" />`. Renders nothing when there is no
unresolved command. Clicking opens the command tray.

### Others

- `ObjectForm` - the generic Add/Edit form for any ObjectDef:
  `<ObjectForm v-model="value" object="CustomerAdd" owner="Customer" :errors="errors" />`.
- `ObjectView` - read-only display of a Ret (all fields, lines as tables, refs as links).
- `FieldInput` - one input chosen from a `FormField` (used by the two above).
- `PermissionEditor` - `v-model` of a permission list (roles and API tokens).
- `XmlEditor` / `XmlView` - highlighted qbXML editing/display.
- `ConflictDiff` - field diff for a conflicted command.

## Stores

- `useAuthStore()`: `user`, `can(permission)`, `canRead(type)`, `canWrite(type)`, `login`, `logout`, `fetchMe`.
- `useEventsStore()`: `status` (idle/connecting/open/reconnecting), `relayConnected`,
  `revisions[type]` (bumped on `object.changed`), `sync[type]`, `on(type | '*', handler)`, `onReconnect(cb)`.
- `useCommandsStore()`: `submit({ op: 'add'|'mod'|'del'|'void', entity, id?, body, base?, formObject?, label? })`
  posts to `/api/objects/...` and tracks the command; `track({ id, op, entity, ... })`
  for commands created elsewhere; `waitFor(id)` resolves on a final status;
  `pendingFor(entity, id)`, `pendingAdds(entity)`, `onSettled(cb)`.
  Purpose-built screens should submit through this store so the tray, optimistic
  badges and conflict handling work for them too.
- `useMetaStore()`: `loadEntities()`, `loadEntity(type)`, `entity(type)`,
  `addObjectName(type)`, `modObjectName(type)`, `ctx(owner)` (form context for `@/forms/model`).

`useObjectEditor({ entity, id? })` (`@/forms/useObjectEditor`) wraps the whole
add/edit workflow for purpose-built screens: it loads metadata (and the object,
or a "reload and reapply" draft), exposes `value` / `errors` / `general` /
`phase` (`loading`, `editing`, `submitting`, `pending`, `done`, `failed`,
`conflict`) and `submit()` (client validation, Add body or Mod diff, submit
through the commands store, server errors mapped onto fields).

Form helpers in `@/forms/model`: `initialValue`, `fromRet` (prefill an edit
form from a Ret), `validateValue` (catalog rules: required by minOccurs,
choices, maxLength, enums, number/date formats), `toBody` (Add body),
`diffForMod` (Mod body: ids + changed fields, lines as TxnLineID-only when
unchanged, `-1` for new lines), `reapply`, `mapServerErrors`.

## Tests

`vitest` runs `test/**/*.test.ts` and `src/**/*.{test,spec}.ts` (module tests
may live next to their code). `test/setup.ts` adds the browser APIs jsdom lacks
(ResizeObserver, matchMedia). Helpers: `test/helpers/api.ts` (route-based fetch
mock), `test/helpers/mount.ts` (Pinia + PrimeVue + router),
`test/helpers/catalog.ts` / `meta.ts` (real catalog and `/api/meta` payloads),
`test/helpers/xsd.ts` (`xsdCheck()`: XSD validation from jsdom tests, run in a
child Node process because libxml2-wasm needs plain Node).

XSD coverage: every Add and Mod form in the catalog (generated with its
required fields filled the way a user would) produces a body that
`buildRequest()` turns into XSD-valid qbXML; realistic Customer/Invoice/
ReceivePayment/JournalEntry adds and mods, conflict reapply, the bodies posted
by the generic screens and every raw-console template are validated too.

## Live updates

The shell opens `GET /api/events` (SSE) after login and reconnects with
backoff (1 s, 2 s, 5 s, 10 s, then every 30 s). `relay.health` drives the
status dot, `command.updated` the tray, `object.changed` refreshes lists and
detail pages. While the stream is down, pending commands are polled every 3 s.

## Raw qbXML console

Admin > qbXML console (`qbxml:raw` permission). Highlighted editor,
local well-formedness check, server-side XSD check while typing (through
`POST /api/qbxml/validate` when the API provides it) and send. The API
validates every document against the XSD before it reaches QuickBooks and
answers 400 with libxml2's line-numbered errors, which the console marks in
the editor.

## API assumptions

The app is tolerant of response shapes (snake_case or camelCase, bare arrays
or `{ items }`). It expects:

- `POST /auth/login {email, password}` and `GET /auth/me` return the user
  (`id`, `email`, `displayName`, `permissions[]`, `roles[]`), bare or under
  `user`, plus an optional `csrfToken` (otherwise the `qbv_csrf` cookie is used).
- `GET /meta/entities/:type` returns `{ entity, objects, requests }` where
  `objects` holds every ObjectDef reachable from the Add/Mod/Ret objects. If one
  is missing, `GET /meta/objects/:name` is tried.
- `POST /objects/:type` takes the bare Add object (`{ Name: 'Acme', ... }`);
  `PATCH /objects/:type/:id` the bare Mod object including the id and
  `EditSequence`. Both answer `202 { commandId }`.
- Validation errors: `400 { error: { code, message, details } }` with `details`
  as a list of `{ path, message }` or libxml2 `{ line, message }` entries, or
  `{ fields: { path: message } }`.
- `POST /qbxml` takes `application/xml` (or `{ qbxml }` after a 415).

## Env

Build/dev only: `VITE_API_PROXY` (dev proxy target). In containers the SPA is
served by nginx (`docker/web.Dockerfile`), which proxies `/api` to `API_UPSTREAM`.
