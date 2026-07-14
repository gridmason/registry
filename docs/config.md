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

## Storage

Records, the review queue, and the audit log live in **Postgres**; artifacts,
release documents, and feeds live in an **S3-compatible object store**. The
defaults below target the local dev stack in [`compose.yaml`](../compose.yaml)
when the service runs on the host against the published ports, so
`npm run dev` works with zero configuration once `docker compose up postgres
minio createbuckets` is running. Production deployments set at least
`DATABASE_URL`, `OBJECT_STORE_ENDPOINT`/region, `OBJECT_STORE_BUCKET`, and
credentials explicitly.

### Postgres

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://gridmason:gridmason@localhost:5432/gridmason` | libpq-style connection URL. |
| `DATABASE_POOL_MAX` | `10` | Maximum pooled connections (1–1000). |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `5000` | Wait for a pooled connection before failing (0–120000). |

### Object store

| Variable | Default | Description |
|---|---|---|
| `OBJECT_STORE_ENDPOINT` | `http://localhost:9000` | Service endpoint (MinIO in dev). Empty = resolve from region (real AWS S3). |
| `OBJECT_STORE_REGION` | `us-east-1` | Region sent with every request. |
| `OBJECT_STORE_BUCKET` | `gridmason-registry` | Bucket holding all registry objects. |
| `OBJECT_STORE_ACCESS_KEY_ID` | `gridmason` | Access key id. Empty = SDK default credential chain. |
| `OBJECT_STORE_SECRET_ACCESS_KEY` | `gridmason-dev-secret` | Secret access key. Empty = SDK default credential chain. |
| `OBJECT_STORE_FORCE_PATH_STYLE` | `true` | Path-style addressing. `true` for MinIO/most self-hosted stores; `false` for real AWS S3. Accepts `true`/`false`/`1`/`0`. |

> The default credentials and secret are **development-only**. Never run a real
> deployment with them.

## Database migrations

The schema is created by a dedicated migration command, not on service boot, so
DDL never applies implicitly:

```sh
npm run migrate                 # local (tsx), uses the same env vars
node dist/db/migrate-cli.js     # container / production (after `npm run build`)
```

Migrations are idempotent — the runner skips already-applied migrations
(tracked in `schema_migrations`) and each migration's SQL is itself
`IF NOT EXISTS`-guarded, so re-running is always safe. In the compose stack a
one-shot `migrate` service runs this automatically before `registry` starts.

Readiness (`/readyz`) reports a `postgres` and an `objectStore` probe; the
service is ready only once both stores are reachable.
