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
| `REGISTRY_ID` | `registry.local` | This instance's source-qualified registry id (SPEC §9). Every output carrying publisher identity is qualified with it so hosts resolve `(registry, publisher, tag)` and pin each prefix to one registry. Production sets it to the instance's canonical id (e.g. `registry.gridmason.dev`). |
| `HTTP_BODY_LIMIT_BYTES` | `65536` | Maximum accepted request body size, in bytes (1024–10485760). The control-plane API takes only small JSON bodies, so this sits well below Fastify's 1 MiB default to bound the memory an unauthenticated caller can force the service to buffer. |
| `HTTP_MAX_HEADER_SIZE_BYTES` | `16384` | Maximum total request header block size, in bytes (8192–1048576), applied at the underlying Node HTTP server. Comfortably above an 8 KiB bearer token plus ordinary headers, but bounded so oversized header floods are rejected early. |

## Identity (OIDC)

Publisher registration is bound to an OIDC identity; the **issuer is the trust
anchor** (SPEC §2). See [`api/publisher.md`](api/publisher.md).

| Variable | Default | Description |
|---|---|---|
| `OIDC_ISSUER_ALLOWLIST` | *(empty)* | Comma-separated list of trusted OIDC issuer URLs. A registration's bearer token is accepted only when its `iss` claim is one of these. **Empty means no issuer is trusted, so no publisher can register (fail closed)** — an instance must set at least one issuer before it accepts registrations. Each entry is **validated at boot**: it must be a well-formed absolute `https://` URL (plain `http://` is permitted only for a loopback host, for local dev). A malformed or insecure entry fails startup with a `ConfigError` rather than surfacing later as a discovery failure at first registration. |
| `OIDC_AUDIENCE` | *(empty)* | Required token audience (`aud`). When set, a registration token is accepted only if its `aud` claim includes this value; empty means the audience is not checked. Set it to this registry's canonical id so a token minted for a different relying party cannot be replayed here. |

> The registration token's **signature is verified** against the issuer's
> published keys: for the token's `iss` (which must be on the allowlist), the
> registry performs OIDC discovery (`<issuer>/.well-known/openid-configuration`),
> fetches the `jwks_uri` key set (cached, with automatic refetch on key
> rotation), and verifies the signature before any claim is trusted. Only
> asymmetric algorithms are accepted — `alg: none` and the `HS*` family are
> refused (alg-confusion guard) — and `exp`/`nbf` are enforced. If the issuer's
> discovery or JWKS endpoint cannot be reached, verification **fails closed** and
> the request is rejected (HTTP `503`), never accepted unverified.
>
> Additional transport hardening on the verification path: neither the discovery
> nor the JWKS fetch **follows HTTP redirects** (`redirect: 'error'`), so a
> compromised or misconfigured allowlisted issuer cannot bounce the request to an
> internal address (e.g. cloud metadata). A bearer token longer than **8 KiB** is
> rejected before it is decoded. Repeated verifications for an issuer the registry
> **cannot reach** back off in-process (a short, growing window) so invalid-token
> spam cannot drive unbounded discovery/JWKS traffic, and a small in-process cache
> of recent *definite* verification failures short-circuits an identical spammed
> token without re-verifying it.

## Human review lane

The single human review lane (SPEC §4, §4a; see
[`review/human-lane.md`](review/human-lane.md)) reads its reviewer roster and the
disclosed flagship waiver from configuration — there is no reviewer console this
phase (SCOPE cut).

| Variable | Default | Description |
|---|---|---|
| `REVIEW_REVIEWER_IDENTITIES` | *(empty)* | Comma-separated list of the OIDC identities permitted to submit a verdict, each in the canonical composite form `<url-encoded-issuer> <url-encoded-subject>` (what `composeOidcIdentity` produces — the same string the audit log and publisher records key on, e.g. `https%3A%2F%2Fissuer.example reviewer-1`). Percent-encoding leaves no literal comma in an entry, so the comma-separated list is unambiguous. **Empty means no identity can review (fail closed).** |
| `REVIEW_SELF_REVIEW_WAIVER` | `false` | The disclosed flagship self-review waiver (SPEC §4a): when `true`, an operator who authored an artifact may also review it (separation of duties waived while the flagship is single-rostered), the use is recorded on the review case and gets its own audit event so the release can be flagged. **Off by default and never enabled on a self-host instance** — every self-hoster keeps reviewer≠author. |

## Countersign + transparency logging

The registry countersignature key is **held separately from review staff**
(SPEC §2, §4a) — its own custody-controlled config fields, distinct from the
reviewer roster above. See [`countersign.md`](countersign.md) for key custody and
the Sigstore public-instance evaluation. When no key is configured the countersign
stage does not mount and approvals record a verdict without publishing a release.

| Variable | Default | Description |
|---|---|---|
| `COUNTERSIGN_PRIVATE_KEY` | *(empty)* | PEM PKCS#8 **ECDSA P-256** private key the registry countersigns approved artifacts with. Sourced from a custody-controlled secret — never a reviewer credential. A single-line value may `\n`-escape its newlines. A configured-but-unusable key fails at boot; empty means no countersign stage. |
| `COUNTERSIGN_CERTIFICATE` | *(empty)* | PEM X.509 (P-256 leaf) certificate carried in the countersignature envelope; hosts pin its issuing root as a countersign root. Must match `COUNTERSIGN_PRIVATE_KEY`. |
| `TRANSPARENCY_LOG_DRIVER` | `memory` | `rekor` for the real Sigstore/Rekor HTTP client (production, GW-D17); `memory` for the in-process RFC 6962 log (dev + tests). |
| `TRANSPARENCY_LOG_REKOR_URL` | `https://rekor.sigstore.dev` | Base URL of the Rekor instance when the driver is `rekor`. |
| `TRANSPARENCY_LOG_ORIGIN` | *(the `REGISTRY_ID`)* | The transparency log's checkpoint `origin` line (its identity in signed tree heads). Defaults to this registry's id so a self-hosted `memory` log names itself. |
| `TRANSPARENCY_LOG_ALLOW_MEMORY_IN_PRODUCTION` | `false` | Escape hatch to run the non-durable `memory` log with `NODE_ENV=production`. See the boot rule below. |

> **Boot rule (#38):** `NODE_ENV=production` with `TRANSPARENCY_LOG_DRIVER=memory`
> is **refused at boot** — the in-process log is not durable and anchors to nothing
> public, so a production instance that forgot to set `rekor` would silently skip the
> public anchoring FR-5 promises. Set `TRANSPARENCY_LOG_DRIVER=rekor`, or, if a
> self-host operator deliberately accepts running a production-mode process with no
> public log, set `TRANSPARENCY_LOG_ALLOW_MEMORY_IN_PRODUCTION=true` to override.
> Outside production the `memory` log stays the zero-config default and only logs a
> boot warning.

If `transparencyLog.append` fails at approval time, the countersign stage retries
with bounded backoff; if every attempt fails it records an audited `release.log_failed`
event and leaves the artifact **approved-but-unpublished** (no release document). An
operator completes it once the log recovers via the re-drive endpoint
`POST /v1/ops/artifacts/:id/redrive-release` (operator-gated; idempotent — an artifact
that already has a release doc returns `409 already_released`).

## Revocation & kill feed

The registry owns distribution state and publishes it as a **signed revocation &
kill feed** (SPEC §6, FR-8) — see [`api/revocation-feed.md`](api/revocation-feed.md).
The feed is signed with the countersign key above (hosts verify it against the same
trust root), so the anonymous feed endpoint mounts only when that key is configured.
The revoke/kill ops endpoints are gated on a **config-listed operator set** (the
same pattern as the reviewer roster — no operator console this phase, SCOPE cut).

| Variable | Default | Description |
|---|---|---|
| `OPS_OPERATOR_IDENTITIES` | *(empty)* | Comma-separated list of the OIDC identities permitted to issue a revoke/kill, each in the canonical composite form `<url-encoded-issuer> <url-encoded-subject>` (what `composeOidcIdentity` produces), exactly as `REVIEW_REVIEWER_IDENTITIES`. **Empty means no identity can operate the kill switch (fail closed).** |
| `REVOCATION_FEED_TTL_SECONDS` | `3600` | Freshness window (seconds) stamped on each served feed: how long a host may cache before it MUST re-check (fail-closed, scoped to this registry). Bounded to `1`–`86400` (the SPEC §6 24 h max TTL); the 1 h default keeps a kill within the §6 online propagation bound (≤ 1 h). |

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
