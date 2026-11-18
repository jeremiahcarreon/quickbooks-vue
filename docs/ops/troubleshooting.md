# Troubleshooting

Start with the two health endpoints:

```bash
# Docker host: app view (database, Redis, relay)
curl -s http://127.0.0.1:8180/api/health | jq .
# Relay view (from the Docker host, over the private network)
curl -s -H "X-Api-Key: $RELAY_API_KEY" http://<relay-addr>:9123/qb/health | jq .
curl -s -H "X-Api-Key: $RELAY_API_KEY" http://<relay-addr>:9123/qb/errors | tail -40
```

| Relay health field                          | What it tells you                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `connected` / `lastError` / `lastErrorTime` | Whether the SDK session is open, and the last COM error                                                 |
| `workerRunning`                             | `false`: the COM thread exited, typically because the SDK is missing. Requests get 503.                 |
| `busy`, `queueDepth`                        | QuickBooks is working on a request, and how many wait behind it                                         |
| `restarts`                                  | Worker restarts since the relay started. A rising count means hung calls, which usually means a dialog. |
| `lastFailure`                               | Last failed request: status, message and `requestId` (search the logs for it)                           |
| `qb`, `qbxmlVersion`                        | Product, file mode (`SingleUser`/`MultiUser`), supported qbXML versions                                 |
| `validation`                                | XSD mode and whether the schema loaded                                                                  |
| `requests`                                  | Counters: `timedOut`, `schemaInvalid`, `schemaRejected`, `tooLarge`, `unauthorized`                     |

Logs:

- Docker host: `docker compose logs --since 1h worker` (also `sync`, `api`). Every relay call carries an `X-Request-Id`, and the relay logs it.
- Windows host: the relay's console window, `C:\Services\QuickBooksVueRelay\qb-errors.log` (also `GET /qb/errors`), and the Event Log (Application).
- Database: the `command` table holds every request and response, and `sync_state.error` holds the last error per entity.

---

## QuickBooks modal dialogs

**Symptoms:** requests time out (relay 504, "worker restarted"). `restarts` climbs, the app's relay indicator flaps, and the command tray fills with `queued` items. `/qb/health` may still say `connected: true`: the session is open, but QuickBooks is waiting for a click.

**Cause:** QuickBooks shows a modal window in the relay user's desktop session, and every SDK call blocks until someone dismisses it. Common ones:

- "Update company file for new version" / "QuickBooks update available" / "Install update now?"
- Backup reminders, "Verify data" prompts, "What's new" or release notes
- An application-certificate prompt ("An application is requesting access to the company file"), usually after a company file upgrade or an `AppName`/`AppID` change, or because the "allow access even if QuickBooks is not running" option was not chosen
- "Sensitive data" access prompts, when the integrated application was not granted sensitive data access
- Error dialogs caused by qbXML that QuickBooks cannot parse. Validation prevents these; see below.
- Single-user/multi-user switch prompts, and "company file is in use"

**Fix:**

1. Connect to the Windows host **as the relay user's session**: RDP, or the console. RDP as a different user does not show the dialog. Use the same account, or, when the session is a console session, `tscon` to take it over without logging it off.
2. Read and dismiss the dialog. If it is an authorization prompt, approve with "Yes, always; allow access even if QuickBooks is not running".
3. `POST /qb/restart` on the relay, or wait. The next timeout restarts the worker anyway.
4. Queued commands resume by themselves. Commands that hit the timeout may have executed, so check them before resubmitting ([3200 and duplicates](#duplicates-after-a-timeout)).

**Prevent:**

- Keep the relay on `ValidateSchema: "enforce"` (the default). The app already validates every request against the XSD, and the relay check also covers any other client.
- QuickBooks: turn off automatic update downloads and prompts; install updates during maintenance windows ([upgrade.md](upgrade.md#3-quickbooks-desktop)). Turn off backup reminders and verify prompts, and tips.
- Authorize the relay with automatic login and sensitive-data access.
- Keep `RequestTimeout` (relay, default 120 s) below the client's `RELAY_TIMEOUT_MS` (default 130000) so the relay, not the client, decides when to restart.

When RDP disconnects, the session stays alive, but QuickBooks UI automation can misbehave in a disconnected session on some builds. If dialogs keep appearing only after RDP disconnects, return the session to the console instead of disconnecting: `tscon %sessionname% /dest:console` from an elevated prompt inside the session.

## Multi-user mode

**Background:** with `AttachToOpenFile: true` (the default), the relay calls `BeginSession("")`, which means "use the company file QuickBooks has open, in its current mode". That lets the relay share the file with people working in Multi-User Mode. With `false`, the relay opens `QbFilePath` itself, single-user, which locks other users out. Use that only on a dedicated, unattended machine.

| Symptom                                                                                                   | Fix                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lastError` mentions "opened in a mode other than the one specified" or "already open in multi-user mode" | Keep `AttachToOpenFile: true` and set `OpenMode: 2` (multi-user) in `appsettings.json`, then restart the relay. Some QuickBooks builds resolve `0` (DoNotCare) to single-user.                                            |
| "Could not start QuickBooks" / "QuickBooks is not running" when attaching                                 | QuickBooks must be running with the file open in the relay user's session, or the app must be authorized to log in automatically ("allow access even if QuickBooks is not running"). Open the file and restart the relay. |
| Other users get "the company file is in use" or are kicked to single-user                                 | Something opened the file single-user: `AttachToOpenFile: false`, or QuickBooks was switched to single-user (File > Switch to Single-user Mode). Switch back to multi-user and keep `AttachToOpenFile: true`.             |
| Writes fail with "record in use" / record-lock errors, or a list item cannot be edited                    | A Desktop user has that record (or list) open in an edit window. QuickBooks locks it. The command shows `failed` with QuickBooks' message. Ask the user to close the window, then resubmit.                               |
| Some operations only work single-user                                                                     | A few QuickBooks operations need single-user mode in Desktop. The SDK returns an error for them in multi-user mode. Do them in QuickBooks Desktop during a maintenance window.                                            |
| `qb.qbFileMode` in health                                                                                 | Shows which mode the relay is attached in                                                                                                                                                                                 |

Hosting: in multi-user setups, keep QuickBooks Database Server Manager running on the machine that hosts the file. Set Windows to not sleep, and leave the relay machine's QuickBooks set to host or not host the file to match your topology.

## 3200: EditSequence out of date (conflicts)

**What it means:** QuickBooks rejects a Mod or Del when the `EditSequence` sent does not match the record's current one. Someone (a Desktop user, another integration, or an earlier command) changed the record after the app last read it. This is optimistic locking working as intended.

**What the app does:** the worker marks the command `conflict`, queries the current version of the object, and stores it in `command.result.current`. The UI shows a field diff with "Reload and reapply". The read model is refreshed with the current version.

**What to do:**

- Users: open the command tray, review the diff, reload and reapply. Never resubmit the same payload blindly; it carries the old `EditSequence` and fails again.
- Integrations: on a 3200, re-`GET /api/objects/:type/:id`, merge your change into the fresh record, and PATCH again with its `EditSequence`.

**When conflicts are frequent:**

- Desktop users and the app edit the same records constantly. That is a process question, not a bug.
- The read model is stale, so the UI edits old versions. Check that sync is current (`sync_state.last_run_at`, `status`) and consider a shorter `SYNC_INTERVAL`.
- Clock skew makes incremental sync miss changes (next section).

### Duplicates after a timeout

A 504 from the relay, or a client timeout, means "unknown": QuickBooks may have applied the Add after the relay gave up. Before resubmitting an Add that timed out, search QuickBooks or the read model (after the next incremental sync) for the record. For integrations, make Adds idempotent on your side, e.g. with a unique `RefNumber` or name that you check first.

## Sync gaps (records missing or stale in the app)

**How sync works:** an incremental pass every `SYNC_INTERVAL` (60 s) asks QuickBooks for records modified since `cursor - SYNC_OVERLAP` (1 min) per entity. `ListDeletedQuery`/`TxnDeletedQuery` pick up deletions. A nightly reconcile (`SYNC_RECONCILE_CRON`, 03:00) compares IDs and `EditSequence`s for everything. Entities whose query has no modified-date filter are fully re-queried every `SYNC_FULL_INTERVAL`.

| Symptom                                                                              | Likely cause                                                                                                                                                                 | Fix                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A record changed in QuickBooks never shows up                                        | **Clock skew** between the Windows host and the Docker host larger than the overlap. Incremental queries use QuickBooks' `TimeModified`, which comes from the Windows clock. | Sync both clocks with NTP: `w32tm /query /status` and `w32tm /resync` on Windows, `timedatectl` on Linux. Raise `SYNC_OVERLAP` (e.g. `5m`) if skew cannot be avoided. Run a reconcile for the type.           |
| A whole type is stale                                                                | Its sync is failing                                                                                                                                                          | `select type, status, error, last_run_at from sync_state where status = 'error';`. Fix the cause, which is often a relay or dialog problem, then `POST /api/admin/sync/<Type>` with `{"mode":"incremental"}`. |
| Some lists (e.g. terms, classes, templates) update only hourly                       | They have no modified-date filter, so they are re-queried on `SYNC_FULL_INTERVAL`                                                                                            | Lower `SYNC_FULL_INTERVAL`, or trigger `POST /api/admin/sync/<Type>`                                                                                                                                          |
| Deleted records still listed                                                         | Deletion detection runs per pass. Some entity types are not covered by `ListDeletedQuery`/`TxnDeletedQuery`.                                                                 | The nightly reconcile marks them. Trigger `{"mode":"reconcile"}` for the type to do it now.                                                                                                                   |
| Records changed by a restore of the QuickBooks file, or a "Condense data", are wrong | The file went back in time, and modified-date cursors are now ahead of it                                                                                                    | Rebuild the read model ([backup-restore.md](backup-restore.md#rebuild-the-read-model-from-quickbooks))                                                                                                        |
| Sync is slow and interactive writes wait                                             | Initial or full loads at priority 10 still yield to writes (priority 1), but each page holds QuickBooks for its duration                                                     | Normal during a first load. Lower `SYNC_PAGE_SIZE` to shorten each hold, or schedule full loads after hours.                                                                                                  |
| `sync.progress` stuck at the same count                                              | A page query is hanging, usually on a dialog                                                                                                                                 | See [modal dialogs](#quickbooks-modal-dialogs)                                                                                                                                                                |

Trigger a sync for one type, or for all with `%2A`:

```bash
curl -X POST -H "Authorization: Bearer <admin token>" -H 'Content-Type: application/json' \
  -d '{"mode":"reconcile"}' https://qb.example.com/api/admin/sync/Invoice
```

Modes: `incremental` (now), `reconcile` (ID and EditSequence comparison, which fixes most drift), and `full` (forget cursors and reload).

## Relay connectivity

| Symptom (worker logs / api health)                        | Check                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ECONNREFUSED` / timeout                                  | Is the relay running (`Get-Process QuickBooksVueRelay`)? Is the tunnel up (`tailscale status`, `wg show`)? Does the firewall rule match the Docker host's tunnel IP?                                                            |
| `401 Invalid API key`                                     | `RELAY_API_KEY` on the Docker host differs from the relay's `ApiKey`. Both are exact, case-sensitive matches, and whitespace counts.                                                                                            |
| `403 IP not allowed`                                      | The address the relay sees is not in `AllowedIPs`. With Tailscale or WireGuard it is the Docker host's **tunnel** address. `requests.unauthorized` counts only 401s, so check the relay log line for the remote address.        |
| `503 worker is not running`                               | QBXMLRP2 is missing for that Windows user, or failed to start. See `lastError`. Repair the QuickBooks install. The relay retries at most every 15 s.                                                                            |
| `413`                                                     | A request is larger than `MaxRequestBodyBytes` (16 MiB). Split the batch.                                                                                                                                                       |
| `400 qbXML failed XSD validation` (relay in enforce mode) | Something sent invalid qbXML past the app's own validation. The app validates before enqueueing, so this points to a different client or a version mismatch between the XSDs on the Docker host and on the relay. Compare them. |
| `500 ... schema is not loaded`                            | Relay is in `enforce` mode without XSDs. Install them (see [server/README.md](../../server/README.md#xsd-validation)), or set `ValidateSchema` to `log` until you can.                                                          |
| Worker logs "circuit open"                                | Expected while the relay is unhealthy. The worker pauses for `CIRCUIT_BREAKER_COOLDOWN` and retries. Fix the relay; the queue resumes by itself.                                                                                |

## Commands stuck or failing

```bash
docker compose exec postgres psql -U qbv -d qbv -c \
  "select status, count(*) from command where created_at > now() - interval '1 day' group by 1;"
docker compose exec postgres psql -U qbv -d qbv -c \
  "select id, rq_name, status, status_code, status_message from command where status in ('failed','rejected','conflict') order by created_at desc limit 20;"
```

- `rejected`: failed XSD validation before sending; never reached QuickBooks. The status message holds the libxml2 error with its line number.
- `failed` with a QuickBooks `status_code`: QuickBooks refused it. Common codes: 3100 (name already in use), 3120 (referenced object not found), 3140 (invalid reference in a field), 3180 (error saving, often a locked record), 3200 (see above). The full response is in `command.response_xml`.
- Stuck in `sending` for longer than `RELAY_TIMEOUT_MS`: the worker process probably died mid-request. Check `docker compose ps worker` and its logs. The outcome in QuickBooks is unknown, so **verify writes in QuickBooks before they are retried or resubmitted**.
- Stuck in `queued` with an idle worker: the Redis job may be missing (e.g. after a Redis flush). Resubmit from the UI, or see [backup-restore.md](backup-restore.md#restore), step 5.
