# Reports module (web)

Registers the routes `/reports` (catalog) and `/reports/:name` (run). It also adds
these items to the **Reports** sidebar area:

- All Reports
- Profit & Loss
- Balance Sheet
- A/R Aging
- A/P Aging
- Open Invoices

Each quick link has its own `report:<name>` permission.

- **Catalog** (`ReportCatalogView`): every report the user may run, from `GET /api/reports`.
  Reports are grouped by category, and the page has a search box and an
  Instant / From QuickBooks filter.
- **Run** (`ReportRunView`): a parameter form (`ReportParamsForm`), the result table
  (`ReportTable`), CSV export and print.
  - The form builds itself from the report's parameter definitions. It has date
    presets (This Month, Last Quarter, Year-to-date, ...) that resolve to explicit
    from/to dates.
  - Instant (SQL) reports run on load. QuickBooks reports wait for **Run**, and while
    the request is queued the view polls with the returned `commandId`.
    **Refresh from QuickBooks** skips the cache.
  - Parameters are mirrored into the URL, so a report link can be shared.
  - The table styles heading, subtotal and total rows, indents nested rows, right-aligns
    numbers, and marks negatives.
  - The print stylesheet prints only the report and repeats the header row on each page.
  - Rows with a read-model link open `entity-detail` when the app registers a
    route with that name.

Tests (from `apps/web`):

```sh
npx vitest run --config src/modules/reports/vitest.config.ts
```
