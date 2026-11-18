# Upgrades

There are three things to upgrade, on separate schedules:

1. **The app** (Docker host): api, worker, sync, web and the database migrations.
2. **The relay** (Windows host).
3. **QuickBooks Desktop** and, rarely, the qbXML schema version.

Before any of them, record the current versions: the app commit (`git rev-parse --short HEAD`), the relay `version` and `qb.productName` from `/qb/health`, and the QuickBooks release (Help > About QuickBooks, then F2).

## 1. The app

### Before

- Read the changes since your current commit (`git log --oneline <current>..origin/master`), especially any migration under `packages/db/src/migrations/` and any change to `docs/configuration.md` (new or renamed variables).
- **Back up** Postgres ([backup-restore.md](backup-restore.md#on-demand)). Migrations change the schema, and the dump is your rollback.
- Make sure `schemas/qbxml/17.0/` still holds the four XSDs. The build needs them.
- Choose a quiet time. The worker drains in seconds, but a running initial sync is interrupted and resumes from its last completed page.

### Drain the write queue

The worker is the only process that talks to QuickBooks. Stop it only when nothing is in flight:

```bash
cd /opt/quickbooks-vue
docker compose exec postgres psql -U qbv -d qbv -c \
  "select status, count(*) from command where status in ('queued','sending') group by 1;"
```

If there are only a few low-priority sync queries, they can wait. Queued jobs stay in Redis and run after the upgrade. If a write is `sending`, wait for it to finish. Stopping in the middle of a write leaves it unknown: QuickBooks may or may not have applied it.

### Upgrade

```bash
cd /opt/quickbooks-vue
git fetch && git checkout <new tag or commit>
docker compose build                    # needs the XSDs; runs codegen inside the image
docker compose stop sync worker         # stop the QuickBooks clients first
docker compose up -d                    # migrate runs first (one-shot); api/worker/sync wait for it
docker compose ps                       # migrate exited 0
docker compose logs migrate | tail -20
curl -s http://127.0.0.1:8180/api/health | jq .
```

Compose recreates only the containers whose image or configuration changed. Postgres and Redis keep their volumes.

### Check

- `/api/health`: `status: "ok"`, relay `connected: true`.
- In the UI: sign in, open a list, open a record. Create and then delete a harmless test record if your process allows it, or run a read-only qbXML query in the console.
- `docker compose logs --since 10m worker sync | grep -iE 'error|rejected'`. Watch for `rejected` commands: a new XSD-validation failure means the build emits qbXML that the schema rejects, and that is a bug to report, not to work around.

### Roll back

- **No migration in the upgrade:** `git checkout <previous commit> && docker compose up -d --build`.
- **With a migration:** run the down migration with the _new_ code (it knows how to undo itself), then go back:
  ```bash
  docker compose run --rm migrate node packages/db/dist/cli/migrate.js down
  git checkout <previous commit> && docker compose up -d --build
  ```
  If the down migration is not possible, restore the backup taken before the upgrade ([backup-restore.md](backup-restore.md#restore)) and then run the previous code.

### Image hygiene

Images built from `docker/node.Dockerfile` contain the Intuit XSDs. Only push them to a private registry. Clean up old local images now and then with `docker image prune`.

## 2. The relay

The HTTP contract (`POST /qb/request`, `GET /qb/health`, `X-Api-Key`, status codes) is stable across relay versions. New health fields and settings are additions, so the relay and the app can be upgraded independently.

1. Pick a quiet moment. While the relay is down, the worker's circuit breaker pauses the queue and retries. Nothing is lost, but writes wait.
2. Copy the new `server/` folder to the Windows host (and the XSDs, if they changed).
3. In an elevated PowerShell, signed in as the relay user:
   ```powershell
   cd server
   .\deploy.ps1                       # stops the old process, installs, starts the new one
   ```
   `deploy.ps1` keeps the existing `appsettings.json`. Compare it with the new `server/QuickBooksVueRelay/appsettings.json` and add any new keys you want to change from their defaults. Missing keys use the documented defaults.
4. Check:
   ```powershell
   Invoke-RestMethod http://localhost:9123/qb/health -Headers @{ 'X-Api-Key' = '<ApiKey>' } | ConvertTo-Json -Depth 4
   ```
   The `version` should be the new one, with `connected: true`, `workerRunning: true` and `validation.schemaLoaded: true` (if the XSDs are installed). From the Docker host, `/api/health` should show the relay connected again within `RELAY_HEALTH_INTERVAL`.
5. Changing `AppName` or `AppID` makes QuickBooks treat the relay as a new application, which has to be authorized again. Avoid it.

Roll back by re-running the previous version's `deploy.ps1`, or by copying the previous `QuickBooksVueRelay.exe` back into the install folder and restarting it.

## 3. QuickBooks Desktop

QuickBooks updates (maintenance releases, and yearly versions such as 23 to 24) can:

- show **modal dialogs** on first start ("Update company file for new version", "Company file has been updated", release notes). All SDK calls hang until someone clicks through them on the Windows host. Expect 504s and relay restarts until then.
- **re-prompt for the integrated application's authorization**, e.g. after a company file upgrade. Re-approve it with "allow access even if QuickBooks is not running".
- change the **supported qbXML versions**. Check `qbxmlVersion` and `qb.supportedQbxmlVersions` in the relay's `/qb/health`. The app sends `QBXML_VERSION` (default `16.0`) and validates against the 17.0 schema. If the new QuickBooks no longer lists the version in `QBXML_VERSION`, set a supported one and restart api, worker and sync.

Procedure:

1. Back up the company file (QuickBooks) and Postgres.
2. Drain and stop the app's QuickBooks clients: `docker compose stop sync worker`.
3. On the Windows host, stop the relay, update QuickBooks, open the company file as admin, and complete every prompt. Multi-user: update the Database Server Manager and every workstation as well.
4. Start the relay and check `/qb/health` (`connected`, `qb.productName`, `qbxmlVersion`).
5. `docker compose start worker sync` and watch `docker compose logs -f worker`.
6. Run a reconcile (`POST /api/admin/sync/%2A` with `{"mode":"reconcile"}`) to confirm that reads still parse.

## qbXML schema version

The app is built against the qbXML **17.0** XSDs. Moving to a newer SDK schema means: put the new XSDs in `schemas/qbxml/<version>/`, set `QBXML_SCHEMA_DIR` to that folder, rebuild (codegen regenerates the catalog and types), and run the full test suite. Also copy the new XSDs to the relay's `SchemaDir`, and set `SchemaFile` if the entry-point name changed. Treat it as a code change, not an ops change.
