# @qbv/config

Environment parsing and logging shared by every Node service.

```ts
import { loadConfig, loggerFromConfig } from '@qbv/config';

const config = loadConfig('worker'); // throws ConfigError listing every bad variable
const log = loggerFromConfig('worker', config);
```

- `loadConfig(service, env?)` for `api`, `worker`, `sync`, `relay-mock`, `migrate`, `seed`.
  Durations (`SYNC_INTERVAL`, `SESSION_TTL`, ...) come back in **milliseconds**.
  Empty strings count as unset.
- Fragments (`commonEnv`, `databaseEnv`, `redisEnv`, `relayEnv`, `qbxmlEnv`, `apiEnv`,
  `workerEnv`, `syncEnv`, `reportsEnv`, `relayMockEnv`, `seedEnv`) and `parseEnv(schema)`
  let a service compose its own schema.
- `createLogger({ service, level, pretty })`: pino, ISO timestamps, secrets redacted.
- `@qbv/config/testing`: `testDatabaseUrl()`, `testRedisUrl()`, `testEnv()` for the
  `npm run infra:up` test stack (Postgres 127.0.0.1:55433, Redis 127.0.0.1:56379).

Every variable is documented in [`docs/configuration.md`](../../docs/configuration.md).

Scripts: `npm run build|test|typecheck|lint -w @qbv/config`.
