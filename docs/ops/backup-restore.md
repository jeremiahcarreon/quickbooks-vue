# Backup, restore and rebuilding from QuickBooks

## What holds what

| Store                                                                 | Contents                                                                                        | Can it be rebuilt?                                                     | Back up?                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **QuickBooks company file** (`.QBW`)                                  | The books. The source of truth.                                                                 | No                                                                     | **Yes**, with QuickBooks' own backup (`.QBB`) or a file-level backup with QuickBooks closed or hosted by Database Server Manager. Follow Intuit's guidance; this guide does not replace it. |
| **Postgres**: `app_user`, `role`, `user_role`, `api_token`, `session` | Accounts, permissions, API tokens                                                               | No                                                                     | **Yes**                                                                                                                                                                                     |
| **Postgres**: `audit_log`, `command`                                  | Who changed what, and the full history of every write sent to QuickBooks (request/response XML) | No. QuickBooks itself records every SDK write as the integration user. | **Yes**                                                                                                                                                                                     |
| **Postgres**: `qb_object`, `sync_state`, `report_cache`               | Read model: a mirror of the company file                                                        | **Yes**, from QuickBooks with a full sync                              | Included in the dump anyway; restoring it avoids hours of re-sync                                                                                                                           |
| **Redis**                                                             | Job queue, pub/sub, locks                                                                       | Jobs point at `command` rows                                           | No                                                                                                                                                                                          |
| **Relay** `appsettings.json`                                          | Relay key, allowlist                                                                            | Re-creatable                                                           | Keep a copy in your password manager                                                                                                                                                        |
| **Docker host settings**                                              | `POSTGRES_PASSWORD`, `SESSION_SECRET`, `RELAY_API_KEY`, ...                                     | Re-creatable, but changing `SESSION_SECRET` signs everyone out         | Keep them in your password manager or secrets store                                                                                                                                         |

Postgres runs inside Compose without a host port, so all commands below go through `docker compose exec` from the repository directory, e.g. `/opt/quickbooks-vue`. They use the default user and database `qbv`; substitute your `POSTGRES_USER` and `POSTGRES_DB`.

## Backup

### On demand

```bash
cd /opt/quickbooks-vue
ts=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T postgres pg_dump -U qbv -d qbv -Fc --no-owner > /var/backups/qbv/qbv-$ts.dump
docker compose exec -T postgres pg_restore -l < /var/backups/qbv/qbv-$ts.dump > /dev/null && echo "dump OK"
```

`-Fc` (custom format) is compressed and allows selective restore. `pg_dump` takes a consistent snapshot while the app keeps running.

### Smaller dumps without the read model

When the read model is large and you are willing to re-sync after a restore:

```bash
docker compose exec -T postgres pg_dump -U qbv -d qbv -Fc --no-owner \
  --exclude-table-data=qb_object --exclude-table-data=report_cache > qbv-core-$ts.dump
```

After restoring such a dump, run [Rebuild the read model](#rebuild-the-read-model-from-quickbooks).

### Scheduled

`/etc/cron.d/qbv-backup`:

```cron
# nightly at 02:15, after business hours and before the 03:00 sync reconcile
15 2 * * * root cd /opt/quickbooks-vue && /usr/local/bin/qbv-backup.sh >> /var/log/qbv-backup.log 2>&1
```

`/usr/local/bin/qbv-backup.sh`:

```bash
#!/bin/sh
set -eu
dir=/var/backups/qbv
mkdir -p "$dir"
ts=$(date -u +%Y%m%dT%H%M%SZ)
out="$dir/qbv-$ts.dump"
docker compose exec -T postgres pg_dump -U qbv -d qbv -Fc --no-owner > "$out.partial"
mv "$out.partial" "$out"
# keep 14 days locally
find "$dir" -name 'qbv-*.dump' -mtime +14 -delete
# copy off the machine, encrypted (pick one: restic, borg, rclone crypt, age + scp, ...)
# restic -r "$RESTIC_REPOSITORY" backup "$out"
```

Backups contain password hashes, hashed API tokens and the full financial read model. Encrypt them at rest and off-site, and restrict access as tightly as the QuickBooks backups.

### Test the backups

At least monthly, restore the latest dump into a scratch database and run a sanity query:

```bash
docker compose exec -T postgres createdb -U qbv qbv_restore_test
docker compose exec -T postgres pg_restore -U qbv -d qbv_restore_test --no-owner < /var/backups/qbv/<file>.dump
docker compose exec -T postgres psql -U qbv -d qbv_restore_test -c "select count(*) from app_user; select type, count(*) from qb_object group by 1 order by 2 desc limit 5;"
docker compose exec -T postgres dropdb -U qbv qbv_restore_test
```

## Restore

Use this to recover from a lost or corrupted database, or to move to a new Docker host.

1. **Stop everything that writes**, leaving Postgres up:
   ```bash
   docker compose stop api worker sync web
   ```
2. **Restore**. Recreate the database for a clean slate:
   ```bash
   docker compose exec -T postgres dropdb -U qbv --if-exists qbv
   docker compose exec -T postgres createdb -U qbv qbv
   docker compose exec -T postgres pg_restore -U qbv -d qbv --no-owner --exit-on-error < /var/backups/qbv/<file>.dump
   ```
3. **Apply newer migrations**, if the code is newer than the dump. `migrate` is a one-shot service and is idempotent:
   ```bash
   docker compose up migrate
   ```
4. **Clear stale queue state.** Redis jobs refer to command ids, and after a restore those may not match the restored rows. Flush the queue and start clean:
   ```bash
   docker compose exec redis redis-cli FLUSHDB
   ```
5. **Commands that were in flight.** Rows in `queued` or `sending` at backup time were never confirmed. **Check QuickBooks before resubmitting writes**: a write may have reached QuickBooks after the dump was taken.
   ```bash
   docker compose exec postgres psql -U qbv -d qbv -c \
     "select id, kind, rq_name, object_type, status, created_at from command where status in ('queued','sending') order by created_at;"
   ```
   For each one, look the object up in QuickBooks. Mark it so it does not show as pending forever, then resubmit from the UI if it really did not happen:
   ```sql
   update command set status = 'failed', status_message = 'Interrupted by restore; verify in QuickBooks', finished_at = now()
   where status in ('queued','sending');
   ```
6. **Start the stack**:
   ```bash
   docker compose up -d
   ```
7. **Catch up with QuickBooks.** The read model is as old as the dump. Incremental sync picks up records modified since each type's cursor, and the nightly reconcile catches deletes. To catch up now:
   ```bash
   # as an admin, via the API (or Admin > Sync in the UI)
   curl -X POST -H "Authorization: Bearer <admin token>" -H 'Content-Type: application/json' \
     -d '{"mode":"reconcile"}' https://qb.example.com/api/admin/sync/%2A
   ```
   (`%2A` is `*`, meaning every entity.)

## Rebuild the read model from QuickBooks

QuickBooks is the source of truth, so the read model can always be thrown away and reloaded. Do this:

- after restoring a core-only dump,
- when you suspect drift that reconcile does not fix,
- after switching the app to a different company file (also clear `command` history for the old file if it is no longer meaningful).

Users, tokens, the audit log and command history are **not** touched.

### Option 1: through the app (no downtime)

Ask the sync service to forget its cursors and reload every entity:

```bash
curl -X POST -H "Authorization: Bearer <admin token>" -H 'Content-Type: application/json' \
  -d '{"mode":"full"}' https://qb.example.com/api/admin/sync/%2A
```

Existing rows stay visible while the reload runs, and are overwritten as fresh data arrives. Rows that no longer exist in QuickBooks are marked deleted by the reconcile pass.

### Option 2: from empty (clean slate)

```bash
cd /opt/quickbooks-vue
docker compose stop sync
docker compose exec postgres psql -U qbv -d qbv -c "begin; truncate qb_object; truncate report_cache; delete from sync_state; commit;"
docker compose start sync
```

With no `sync_state` rows, the sync service runs an initial load for every entity at the lowest queue priority. Until it finishes, lists in the UI are incomplete. Interactive writes still work, because they go straight to QuickBooks and write their results through.

### How long it takes

SDK throughput depends on the record type (transactions with many lines are slow), the hardware, and whether Desktop users are active. Large files can take hours. The duration of your first initial load, recorded in `sync_state.last_full_sync_at` and the sync logs, is the best estimate for a rebuild. Watch progress:

```bash
docker compose exec postgres psql -U qbv -d qbv -c \
  "select type, status, row_count, last_full_sync_at, error from sync_state order by status, type;"
```

Run full rebuilds outside business hours. Desktop users and the rebuild compete for the same single-threaded QuickBooks.

## Moving to a new Docker host

1. On the old host, run `docker compose stop api worker sync web`, then take a final dump.
2. On the new host: [deployment.md](deployment.md) steps 3.1–3.3 (same `SESSION_SECRET`, `RELAY_API_KEY` and `POSTGRES_PASSWORD`), then `docker compose up -d postgres redis`.
3. Restore as above (steps 2–7).
4. Add the new host's private address to the relay's `AllowedIPs` (and the tunnel ACL), and remove the old one.
5. Point DNS or the reverse proxy at the new host.
