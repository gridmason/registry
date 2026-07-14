# Configuration

The registry service is configured entirely through environment variables. All
are optional at this stage and fall back to the defaults below. Values are
parsed and validated once at startup (`src/config`); an invalid value fails the
boot immediately with a descriptive `ConfigError` rather than surfacing later.

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | Deployment mode. One of `development`, `production`, `test`. |
| `HOST` | `0.0.0.0` | Network interface the HTTP server binds to. |
| `PORT` | `8080` | TCP port the HTTP server listens on (1–65535). |
| `LOG_LEVEL` | `info` | Minimum structured-log level. One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. |
| `SERVICE_NAME` | `gridmason-registry` | Logical service name attached to every log line and health response. |
| `REQUEST_ID_HEADER` | `x-request-id` | Inbound/outbound header carrying the request correlation id. If a request arrives with this header set, its value is adopted as the request id; otherwise a UUID is generated. The id is echoed back on the response and bound to every log line as `reqId`. Compared case-insensitively. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period (ms) for in-flight requests to drain on `SIGTERM`/`SIGINT` before the process force-exits (0–300000). |

Storage-related variables (Postgres, S3-compatible object store) are introduced
in [#3](../../../issues/3) and will be documented here when that lands.
