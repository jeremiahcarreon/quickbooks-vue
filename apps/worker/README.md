# @qbv/worker

The only process that talks to the relay. It consumes the BullMQ `relay` queue
with concurrency 1, sends each command's qbXML to QuickBooks through
`@qbv/relay-client`, and writes the outcome back to Postgres
(DESIGN section 6.4).

```sh
npm run build -w @qbv/worker
npm start -w @qbv/worker      # node dist/main.js (needs the env below)
npm test -w @qbv/worker       # needs `npm run infra:up` and the qbXML XSDs
```

## Command lifecycle

`queued -> sending -> succeeded | failed | conflict | rejected`

1. Load the command. Commands that are already final, or missing, are skipped.
   If `request_xml` is empty, it is built from `rq_name` + `payload` with
   `buildRequest`.
2. **Re-validate `request_xml` against the XSD** (libxml2, `@qbv/qbxml`). On
   failure the command becomes `rejected` with the libxml2 errors in
   `result.validationErrors`. It is never sent. The relay client validates a
   second time before sending, and so does every follow-up query the worker
   builds.
3. Mark `sending` (attempts + 1, `command.updated`), then POST the document to
   the relay.
4. Interpret the response with `parseResponse`. Results are mapped to requests
   by `requestID`, falling back to position, so batches work with either
   `onError`.
   - All responses OK (status 0 or a warning below 1000): `succeeded`. Every
     returned Ret of a write is upserted into `qb_object` in the same
     transaction that finishes the command. Partial Rets
     (`IncludeRetElement`) are not stored. `ListDel`/`TxnDel` set `deleted_at`.
     `TxnVoid` re-reads the transaction (with line items) and upserts it.
     `object_id` is set to the new ListID/TxnID for adds.
   - `3200` (EditSequence out of date): `conflict`. The current object is
     fetched with a validated query, stored in `result.current` and upserted.
   - Any other error: `failed`, keeping QuickBooks' status code and message.
     In a batch, the first error decides. Requests QuickBooks never reached
     (`stopOnError`) are listed in `result.notProcessed`.
5. An `audit_log` row (`action` = `qb.add|qb.mod|qb.del|qb.void|qb.raw`) is
   written for every write command, whatever its outcome. Raw documents count
   as writes unless every request is a query. Query and report commands are
   not audited.
6. Events go to `qbv:events`: `command.updated` on every status change,
   `object.changed` for every object written (`add`, `mod`, `del`, `void`,
   and `sync` for a conflict refresh), and `relay.health` when relay health
   changes.

Queries never touch the read model; sync owns that. Query options such as
`IncludeLineItems` or `IncludeRetElement` can return partial objects, which
would overwrite complete ones.

### `command.result`

```jsonc
{
  "responses": [
    {
      "requestID": "1",
      "name": "CustomerAddRs",
      "statusCode": 0,
      "statusSeverity": "Info",
      "statusMessage": "Status OK",
      "retNames": ["CustomerRet"],
      "rets": [{/* parsed Ret */}],
      "retCount": 1,
      "iteratorID": "...",
      "iteratorRemainingCount": 0,
      "fields": {/* non-Ret content, e.g. ListDelType/ListID/TimeDeleted */},
    },
    { "requestID": "2", "name": "CustomerAddRs", "notProcessed": true },
  ],
  "object": {/* first Ret written (write commands) */},
  "changed": [{ "objectType": "Customer", "qbId": "80000001-1", "op": "add" }],
  "current": {/* conflict only: the object as QuickBooks has it now */},
  "notProcessed": [{ "requestID": "2", "name": "CustomerAddRq" }],
  "warnings": ["..."],
  "verification": { "resent": true, "outcome": "resent|applied|unknown", "reason": "..." },
  "validationErrors": [{ "line": 3, "message": "..." }], // rejected only
  "relayError": { "name": "RelayQbError", "status": 502, "message": "..." },
}
```

`response_xml` always holds QuickBooks' raw response when there was one.

## Relay failures, retries and the circuit breaker

| Relay outcome                                    | What happens                                                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 503, 504, network error, client timeout          | Transient. The command goes back to `queued` and the job is retried with the job's backoff, up to `min(job attempts, WORKER_MAX_ATTEMPTS)` attempts. After the last attempt the command is `failed`. |
| 502 (COM failure), 401, 403, 404, protocol error | `failed` straight away. For writes the message notes that QuickBooks may have applied the change.                                                                                                    |

Any transient failure **opens the circuit breaker**. The BullMQ worker is
paused, so queued commands wait in Redis instead of using up their attempts.
After `CIRCUIT_BREAKER_COOLDOWN` the relay is pinged. As soon as it answers,
the circuit goes half-open and the next job decides: success closes the
circuit, another transient failure opens it again. Relay health is also
polled every `RELAY_HEALTH_INTERVAL`, and `relay.health` events are published
on every change. A relay that cannot be reached at all opens the circuit. The
relay's own `connected` flag is reported but does not open the circuit by
itself, because the relay documents that it can be stale.

## Never resending a write blindly

A write that may have reached QuickBooks without our seeing the answer is
dangerous to resend: an Add sent twice creates two customers or two
invoices. This happens when the worker crashes or is killed mid-send (the
command is left in `sending`), or when the relay times out (504 or the
client-side timeout; QuickBooks may still finish the request). In the second
case the command goes back to `queued` with a `result.pendingVerification`
marker.

Before such a command is sent again, the worker checks QuickBooks with a
(validated) query:

| Request                                                                                                                                  | Check                                                                                               | Result                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Query / report                                                                                                                           | none                                                                                                | resent                                                                                                             |
| `*ModRq`                                                                                                                                 | none needed: the Mod carries its EditSequence, so QuickBooks rejects a second application with 3200 | resent. A 3200 is reported as `conflict` with a note that the first attempt may have been applied.                 |
| `TxnVoidRq`                                                                                                                              | none needed: voiding twice has no further effect                                                    | resent                                                                                                             |
| `ListDelRq` / `TxnDelRq`                                                                                                                 | query by id                                                                                         | gone: `succeeded` (marked deleted), not resent. Still there: resent.                                               |
| List `*AddRq` with `Name`                                                                                                                | query by FullName (unique per list), created since the first attempt                                | found: `succeeded` with that object, not resent. Not found: resent.                                                |
| Txn `*AddRq` with `RefNumber`                                                                                                            | query by RefNumber, created since the first attempt                                                 | one found: `succeeded`. None: resent. Several: `failed`.                                                           |
| Anything else (txn Add without RefNumber, list Add whose parent is given by ListID only, other raw writes, batches applied only in part) | cannot be confirmed                                                                                 | `failed` with a message explaining that it was not resent to avoid a duplicate and should be checked in QuickBooks |

"Created since" allows 15 minutes of clock difference between this server and
the QuickBooks host.

On startup, `recoverPending` makes sure every `queued`/`sending` command has a
live job. Jobs that are missing, completed or failed are re-added. Commands
left in `sending` then go through the check above when their job runs.
`queue.setGlobalConcurrency(1)` is set on startup, so even a second worker
replica would not send QuickBooks two requests at once. Run one replica
anyway.

## Shutdown

On SIGTERM or SIGINT the worker stops taking jobs and waits for the command in
flight to finish. The relay call can take up to `RELAY_TIMEOUT_MS`, so the
compose fragment sets `stop_grace_period: 150s`. A second signal exits at
once; the interrupted command is then checked as described above on the next
start. A job that fails for an unexpected reason (database down, bug) is
retried by BullMQ. After its last attempt, the command is marked `failed`
rather than being left `queued`/`sending`.

## Configuration

Read with `loadConfig('worker')` from `@qbv/config`. All variables are listed
in [docs/configuration.md](../../docs/configuration.md).

| Variable                                            | Default              | Use                                                                                                                                         |
| --------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `DATABASE_POOL_MAX`, `DATABASE_SSL` |                      | Postgres                                                                                                                                    |
| `REDIS_URL`, `QUEUE_PREFIX`                         | `qbv`                | BullMQ connection and key prefix                                                                                                            |
| `RELAY_URL`, `RELAY_API_KEY`, `RELAY_TIMEOUT_MS`    | `130000`             | Relay endpoint, `X-Api-Key`, per-request timeout                                                                                            |
| `QBXML_VERSION`                                     | `16.0`               | Header on follow-up queries the worker builds                                                                                               |
| `QBXML_SCHEMA_DIR`                                  | `schemas/qbxml/17.0` | XSDs. The worker refuses to start without them.                                                                                             |
| `WORKER_MAX_ATTEMPTS`                               | `5`                  | Upper bound on attempts per command                                                                                                         |
| `WORKER_BACKOFF`                                    | `2s`                 | Base of the backoff for jobs enqueued with `backoff: { type: 'custom' }`. Jobs from `enqueueCommand` use their own exponential 2 s backoff. |
| `RELAY_HEALTH_INTERVAL`                             | `15s`                | Health polling                                                                                                                              |
| `CIRCUIT_BREAKER_COOLDOWN`                          | `30s`                | Minimum time the circuit stays open                                                                                                         |
| `LOG_LEVEL`, `LOG_PRETTY`                           | `info`               | pino logging                                                                                                                                |

## Library use

```ts
import { CommandProcessor, RelayWorker } from '@qbv/worker';
```

`CommandProcessor` runs one command without BullMQ (useful in tests).
`RelayWorker` wires it to the queue, the circuit breaker and recovery.

## Tests

- `test/processor.test.ts`: every outcome against real Postgres and a small
  fake relay HTTP server. It covers add, mod, conflict, del, void, query,
  report, raw batches with `continueOnError` and `stopOnError`, XSD
  rejections, 503/504/502/401 and garbage responses, and each
  interrupted-write case.
- `test/worker.test.ts`: BullMQ and Redis end to end. It covers priority order
  (1, 2, 5, 8, 10), one request at a time, retries with the circuit breaker
  and `relay.health`, max attempts, startup recovery, graceful shutdown and
  the failed-job safety net.
- `test/request-info.test.ts`, `test/circuit.test.ts`: unit tests.

The fake relay validates every document it receives against the XSD, and
every test asserts that no invalid document reached it.
