# @qbv/relay-client

Typed client for the relay contract (DESIGN section 6.5, `server/README.md`).

```ts
import { relayClientFromConfig, RelayError } from '@qbv/relay-client';

const relay = relayClientFromConfig(config); // RELAY_URL, RELAY_API_KEY, RELAY_TIMEOUT_MS
const responseXml = await relay.request(qbxml); // XSD-validated before sending
const health = await relay.health(); // { connected, lastError, lastRequestTime, uptime }
const { ok, connected } = await relay.ping(); // never throws
```

`request()` always validates the document against the XSD first (via
`@qbv/qbxml` `validate`, or an injected `validator`) and throws
`RelayValidationError` without sending. Validation cannot be turned off.

Errors (all extend `RelayError` with `status`, `retryable`, `mayHaveExecuted`):

| Class                   | When                                      | retryable | mayHaveExecuted                 |
| ----------------------- | ----------------------------------------- | --------- | ------------------------------- |
| `RelayBadRequestError`  | 400                                       | no        | no                              |
| `RelayAuthError`        | 401 bad API key                           | no        | no                              |
| `RelayForbiddenError`   | 403 IP not allowed                        | no        | no                              |
| `RelayNotFoundError`    | 404                                       | no        | no                              |
| `RelayQbError`          | 502 COM failure, or `error` in a 200 body | no        | yes                             |
| `RelayUnavailableError` | 503 QuickBooks not connected              | yes       | no                              |
| `RelayTimeoutError`     | 504, or no answer within `timeoutMs`      | yes       | yes                             |
| `RelayNetworkError`     | refused / DNS / reset                     | yes       | only if the connection was made |
| `RelayProtocolError`    | non-contract response                     | no        | yes                             |
| `RelayValidationError`  | XSD validation failed, nothing sent       | no        | no                              |

`mayHaveExecuted` matters for writes: QuickBooks may have applied the change,
so re-query before retrying an Add.
