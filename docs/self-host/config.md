# Self-host configuration reference

Every setting a self-hosted Gridmason Registry reads, on one page, framed for an
operator standing up an instance. The registry is configured **entirely through
environment variables** (`src/config`); each is parsed and validated once at boot,
and an invalid value fails startup immediately with a descriptive `ConfigError`.

This page is the self-host view — grouped by what you **must** set, the backing
stores, and the optional tuning knobs. [`../config.md`](../config.md) is the
**authoritative per-field reference** with the full semantics, security notes, and
verification-path detail; where a setting needs more than a line, it links there. The
two never disagree because the detail lives in one place — this page summarizes it for
the install.

Everything here is **self-host-neutral**: none of the flagship's launch-phase waivers
(SPEC §4a) apply to a self-hosted instance.

## Must set for production

An instance boots with none of these, but it is not production-ready until they are set:
identity is fail-closed (no issuer ⇒ no publisher can register), and the countersign,
review, and ops surfaces do not act until their identities/keys are configured.

| Variable | Default | Self-host note |
|---|---|---|
| `REGISTRY_ID` | `registry.local` | Your instance's canonical id (e.g. `registry.example.com`). Becomes the widget `source` string and qualifies every published identity; also the default trust-root `registryId` and log `origin`. Set it. |
| `OIDC_ISSUER_ALLOWLIST` | *(empty)* | Comma-separated trusted OIDC issuer URLs — the authorship trust anchor (SPEC §2). **Empty = no publisher can register (fail closed).** Validated at boot: absolute `https://` (plain `http://` only for loopback). Flows into the trust-root `issuerAllowlist`. |
| `OIDC_AUDIENCE` | *(empty)* | Required token `aud`. Set it to this registry's id so a token minted for another relying party cannot be replayed here. |
| `COUNTERSIGN_PRIVATE_KEY` | *(empty)* | PEM PKCS#8 **ECDSA P-256** private key the registry countersigns approved artifacts with. Custody-controlled secret — never a reviewer credential. Empty ⇒ no countersign stage (Phase-A author-loop shape). See [`generating a key`](../countersign.md#generating-a-self-signed-countersign-key-self-hosters). |
| `COUNTERSIGN_CERTIFICATE` | *(empty)* | PEM X.509 (P-256 leaf) carried in the countersignature; its public key is your **countersign root** (hosts pin its SHA-256 fingerprint). Must match `COUNTERSIGN_PRIVATE_KEY`. |
| `REVIEW_REVIEWER_IDENTITIES` | *(empty)* | Comma-separated OIDC identities allowed to submit a review verdict, in the composite form `composeOidcIdentity` produces. **Empty = no one can review (fail closed).** |
| `OPS_OPERATOR_IDENTITIES` | *(empty)* | Comma-separated OIDC identities allowed to issue a revoke/kill, same composite form. **Empty = the kill switch cannot act (fail closed).** |
| `TRANSPARENCY_LOG_DRIVER` | `memory` | Set to `rekor` for a real instance so releases are **publicly anchored**. `memory` is the in-process log (not durable, not public) — the boot guard refuses it under `NODE_ENV=production` unless you accept no public log (below). |
| `NODE_ENV` | `development` | Set to `production`. Turns on the transparency-log boot guard and production error verbosity. |

> **`REVIEW_SELF_REVIEW_WAIVER` — never set this on a self-host instance.** It is the
> disclosed flagship single-roster waiver (SPEC §4a); a self-hoster keeps reviewer ≠
> author. It defaults to `false` and is documented only so you know to leave it off.

## Backing stores

Records, the review queue, and the audit log live in **Postgres**; artifacts, release
documents, and feeds live in an **S3-compatible object store**. The defaults target the
local [`compose.yaml`](../../compose.yaml) MinIO/Postgres stack; a real deployment points
them at managed services.

| Variable | Default | Self-host note |
|---|---|---|
| `DATABASE_URL` | `postgres://gridmason:gridmason@localhost:5432/gridmason` | libpq-style URL. Point at managed Postgres; the default credentials are **dev-only**. |
| `DATABASE_POOL_MAX` | `10` | Max pooled connections (1–1000). |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `5000` | Wait for a pooled connection before failing (0–120000). |
| `OBJECT_STORE_ENDPOINT` | `http://localhost:9000` | S3 endpoint (MinIO in dev). **Empty = resolve from region (real AWS S3).** |
| `OBJECT_STORE_REGION` | `us-east-1` | Region sent with every request. |
| `OBJECT_STORE_BUCKET` | `gridmason-registry` | Bucket holding all registry objects. |
| `OBJECT_STORE_ACCESS_KEY_ID` | `gridmason` | Access key id. **Empty = SDK default credential chain** (IAM role, etc.). |
| `OBJECT_STORE_SECRET_ACCESS_KEY` | `gridmason-dev-secret` | Secret access key. Empty = SDK default chain. |
| `OBJECT_STORE_FORCE_PATH_STYLE` | `true` | `true` for MinIO/most self-hosted stores; **`false` for real AWS S3.** |

> The default store credentials are **development-only** — never run a real deployment
> with them. Readiness (`/readyz`) reports a `postgres` and an `objectStore` probe; the
> instance is ready only once both are reachable.

## Transparency log & revocation

| Variable | Default | Self-host note |
|---|---|---|
| `TRANSPARENCY_LOG_REKOR_URL` | `https://rekor.sigstore.dev` | Rekor base URL when the driver is `rekor`. |
| `TRANSPARENCY_LOG_ORIGIN` | *(the `REGISTRY_ID`)* | The log checkpoint `origin` line (the log key's `name`). Defaults to your registry id so a `memory` log names itself. |
| `TRANSPARENCY_LOG_MEMORY_KEY` | *(empty → ephemeral)* | A **stable** signing key for the in-process `memory` log, as base64 of a PKCS#8 DER Ed25519 private key. Empty regenerates a key each boot (not pinnable across restarts). Set it so hosts can pin the log and releases keep verifying after a restart. Generate with `npm run log-key:gen`. Dev/e2e only — production uses `rekor`. |
| `TRANSPARENCY_LOG_ALLOW_MEMORY_IN_PRODUCTION` | `false` | Escape hatch to run the non-durable `memory` log under `NODE_ENV=production`, accepting **no public anchoring**. The compose stack sets it so the quickstart boots; a real instance uses `rekor` instead. |
| `REVOCATION_FEED_TTL_SECONDS` | `3600` | Freshness window stamped on the signed revocation/kill feed (1–86400; SPEC §6 caps at 24 h). The 1 h default keeps a kill within the online propagation bound. |

> **Boot guard (#38):** `NODE_ENV=production` + `TRANSPARENCY_LOG_DRIVER=memory` is
> **refused at boot** — a production instance that forgot `rekor` would silently skip the
> public anchoring FR-5 promises. Set `rekor`, or set
> `TRANSPARENCY_LOG_ALLOW_MEMORY_IN_PRODUCTION=true` to deliberately accept no public log.

### Pinning the transparency-log key

A host verifies a release's inclusion proof against a **pinned transparency-log
checkpoint key** (`verifyRelease` requires it, fail-closed), so an instance must be
able to hand that key out. How depends on the driver:

- **`memory` (dev/e2e).** The key is the Ed25519 checkpoint signer. Without
  `TRANSPARENCY_LOG_MEMORY_KEY` it is **regenerated every boot**, so a restart
  orphans every previously logged release's proof and no host can pin it. The flow
  to fix that — **generate once → project as env → publish → hosts pin**:

  ```sh
  npm run log-key:gen        # prints TRANSPARENCY_LOG_MEMORY_KEY=… + the public key
  export TRANSPARENCY_LOG_MEMORY_KEY="…"   # project the private key into the service
  npm run trust-root:init    # now writes logPublicKeys: ["ed25519:<origin>:<base64 key>"]
  ```

  The service also **prints the active key at boot** as
  `{ name, key }` (name = the log origin, key = base64 raw 32-byte Ed25519), so an
  operator can copy it straight into a host's `logPublicKey` pin. The trust-root
  document encodes each key as `ed25519:<name>:<base64 raw 32-byte key>`.

- **`rekor` (production).** The registry does not operate the log, so it does not
  derive a checkpoint key — hosts pin the **public Rekor instance's** key. Supply it
  via `TRUST_ROOT_LOG_PUBLIC_KEYS` (below) so `trust-root:init` publishes it.

## Transport & runtime (defaults are usually fine)

| Variable | Default | Self-host note |
|---|---|---|
| `HOST` | `0.0.0.0` | Interface the HTTP server binds to. |
| `PORT` | `8080` | Listen port (1–65535). |
| `LOG_LEVEL` | `info` | One of `fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent`. |
| `SERVICE_NAME` | `gridmason-registry` | Logical name on every log line and health response. |
| `REQUEST_ID_HEADER` | `x-request-id` | Inbound/outbound correlation-id header. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Drain grace on `SIGTERM`/`SIGINT` before force-exit (0–300000). |
| `HTTP_BODY_LIMIT_BYTES` | `65536` | Max request body (1024–10485760). |
| `HTTP_MAX_HEADER_SIZE_BYTES` | `16384` | Max request header block (8192–1048576). |

## Trust-root generation (install tooling)

These are read by the install tooling, **not** the running service: `npm run
trust-root:init` when it generates `trust-root.json` (see
[`install.md`](install.md#2-generate-the-trust-roots)) **and** `npm run rotate:root`
when it generates an overlap document during a rotation (see the
[rotation runbook](rotation.md)). Both also read `REGISTRY_ID`,
`OIDC_ISSUER_ALLOWLIST`, and the countersign key above.

> **When rotating, carry these forward.** A rotation moves only the countersign root;
> the other trust anchors are re-read from the environment, not copied from the old
> document. `rotate:root` reads `TRUST_ROOT_PUBLISHER_CA_ROOTS` and
> `TRUST_ROOT_LOG_PUBLIC_KEYS` the same way `trust-root:init` does, so set them to the
> same values you installed with — omitting them drops your custom CA roots / log keys
> from the overlap document.

| Variable | Default | Self-host note |
|---|---|---|
| `TRUST_ROOT_LOG_PUBLIC_KEYS` | *(empty)* | Comma-separated transparency-log public keys hosts pin (SPEC §4.3), appended to what the registry derives. A **stable** `memory` log (`TRANSPARENCY_LOG_MEMORY_KEY`) is added automatically, so leave this empty for it; set it for the public **Rekor** key, or an ephemeral `memory` log has nothing to publish. |
| `TRUST_ROOT_PUBLISHER_CA_ROOTS` | *(empty)* | Comma-separated publisher-CA roots for the issued-cert authorship path (SPEC §4.4). Omit for the keyless OIDC path this cut uses. |

`--validity-days` (CLI flag, default `365`) sets the trust-root validity window.

## Database migrations

The schema is applied by a dedicated command, never on boot:

```sh
npm run migrate                 # local (tsx)
node dist/db/migrate-cli.js     # container / production (after build)
```

Migrations are idempotent (tracked in `schema_migrations`, each `IF NOT EXISTS`-guarded).
In the compose stack a one-shot `migrate` service runs this before `registry` starts.
