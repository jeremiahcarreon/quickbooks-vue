# @qbv/queue

The single BullMQ queue (`relay`) that serialises every QuickBooks request, and
the `qbv:events` pub/sub channel (DESIGN section 6.3).

```ts
import {
  createRedis,
  createRelayQueue,
  createEventBus,
  enqueueCommand,
  waitForCommand,
  Priority,
} from '@qbv/queue';

const redis = createRedis(config.REDIS_URL);
const queue = createRelayQueue(redis, { prefix: config.QUEUE_PREFIX });
const events = createEventBus(config.REDIS_URL);

const { command } = await enqueueCommand(
  db,
  queue,
  {
    kind: 'add',
    rqName: 'CustomerAddRq',
    objectType: 'Customer',
    payload: body,
    requestXml: buildRequest('CustomerAddRq', body),
    priority: Priority.InteractiveWrite,
    actorType: 'user',
    actorId: user.id,
  },
  { events },
);

const { done, command: result } = await waitForCommand(db, command.id, {
  events,
  timeoutMs: 30_000,
});
```

- `enqueueCommand` **validates `requestXml` against the XSD** (via
  `@qbv/qbxml` `validate`, or an injected `validator`) and throws
  `QbxmlRejectedError` before anything is stored. It then inserts the command
  row (`queued`) and adds the job with `jobId = command id` and the given
  priority. Default job options: 5 attempts, exponential backoff from 2s.
- `Priority`: `InteractiveWrite` 1, `InteractiveRead` 2, `IncrementalSync` 5,
  `ReportFetch` 8, `BulkSync` 10 (lower runs first).
- `RelayJobData` is `{ commandId }`; job name `command`.
- `reenqueuePending(db, queue)` re-adds jobs for queued/sending commands (idempotent).
- Events: `object.changed`, `command.updated`, `sync.progress`, `relay.health`
  (`QbvEvent` union, `parseEvent`, `publishEvent`, `createEventBus`).

Tests need the test infra (`npm run infra:up`) and the qbXML schemas.

Env: `REDIS_URL`, `QUEUE_PREFIX` (default `qbv`). See
[docs/configuration.md](../../docs/configuration.md).
