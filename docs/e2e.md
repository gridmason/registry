# Full-chain e2e (FR-13)

The Phase-B-exit proof (SPEC §11): the whole registry works end to end — publish →
review → countersign → resolve + verify — driven over **real HTTP** against a
**compose-launched instance**, with the SPEC §6/§10 failure modes (revoked
artifact excluded, stale feed fail-closed) asserted, not just the happy path.

The suite lives at [`test/e2e/full-chain.e2e.ts`](../test/e2e/full-chain.e2e.ts)
and runs under its own config ([`vitest.e2e.config.ts`](../vitest.e2e.config.ts))
so the fast unit run (`npm test`) stays infra-free. CI runs it as the dedicated
`full-chain-e2e` job ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

## What the instance under test is

The e2e boots the **real service** (`buildServer`, the same wiring
[`src/index.ts`](../src/index.ts) boots) in-process against the **R-E0 compose
stack's Postgres + object store**, and drives it over a real socket with `fetch`.
The OIDC issuer, reviewer roster, operator set, and countersign key are
test-provided config — exactly what a self-host operator provides at install
([`self-host/install.md`](self-host/install.md)) — and the transparency log is the
in-process `memory` log the compose default uses (injected so the host-side
log-inclusion check can read its checkpoint key). The serving origin
(`GET /v1/artifacts/:hash`) is exercised unchanged, never modified.

> The full **container** quickstart (image + Postgres + object store, `docker
> compose up --build`, trust-root generation, policy page) is separately smoke-
> tested by the `self-host-smoke` job. This e2e uses the documented "backing
> stores + run the service from the host" compose mode (see
> [`compose.yaml`](../compose.yaml)) because the chain needs test-controlled OIDC
> config, and the loader accepts an `http://` issuer only on loopback.

## The chain, part by part

| Part | Driven how | Steps |
|---|---|---|
| **A** | real HTTP, compose | publisher register → **DSSE** upload → the registry's **real** automated review (the shared [`@gridmason/cli/checks`](review/automated.md) the CLI runs) → `/v1/artifacts/:id/status` poll → human approve |
| **B** | real HTTP, compose, **seeded** release | seed an artifact carrying the protocol publisher envelope → approve over HTTP (fires the real countersign stage) → resolve the fragment → verify each URL with `@gridmason/protocol` `verifyRelease` + serving hash → **kill → excluded** (SPEC §6) |
| **C** | real HTTP, compose | fetch the signed revocation feed → authenticate with `verifyRevocationFeed` → `evaluateFreshness`: fresh (blocks the killed artifact) and **stale-past-TTL fail-closed** (SPEC §6, §10) |

### The two asserted failure modes (the point of FR-13)

- **Revoked/killed excluded from resolution (fail closed for revocation).** Part B
  kills the approved, countersigned artifact through the operator ops endpoint and
  asserts `POST /v1/resolve` then returns it in `excluded` (`not_distributable`),
  never in `imports`.
- **Stale feed past the 24 h TTL fails closed.** Part C runs the served,
  signature-authenticated feed through `evaluateFreshness` with a clock past
  `issuedAt + ttlSeconds` and asserts a `stale` (fail-closed) verdict.

## Why Parts B/C are seeded, and A stops at approve — the contract gaps

The chain cannot yet be driven **entirely** by the real `gridmason` binary against
a real countersigned release, because of two cross-repo contract gaps (tracked in
[`gridmason/cli#70`](https://github.com/gridmason/cli/issues/70), referenced by
[`#19`](https://github.com/gridmason/registry/issues/19)):

1. **No CI-drivable offline signer.** `@gridmason/cli@0.5.1`'s `publish` binary
   hardwires the live Sigstore keyless signer (`dist/commands/publish.js` →
   `sigstoreSigner`; options only `--token`/`--ambient`/`--sigstore`). The offline
   `ephemeralSigner` + programmatic `runPublish` are not in the package `exports`,
   so the binary cannot publish deterministically in CI and the offline path
   cannot be imported. So this suite drives the CLI-shaped publish via the
   documented Publish API directly (a real HTTP upload of the DSSE envelope the CLI
   produces + the real shared checks), rather than shelling out to a binary that
   would need Sigstore network.

2. **Envelope-shape gap (the unbuilt "P-E3" bridge).** The CLI uploads a **DSSE**
   envelope (`{ payloadType, payload, signatures[] }`); intake stores exactly that
   ([`src/artifact/envelope.ts`](../src/artifact/envelope.ts)). But countersign
   requires the protocol **`SignatureEnvelope`** (`{ formatVersion, subject,
   publisherSig{ cert, issuer, subjectClaims, sig } }`) and refuses a DSSE envelope
   as `envelope-unusable` ([`src/countersign/countersign.ts`](../src/countersign/countersign.ts),
   `parsePublisherEnvelope`). Nothing converts one to the other, so an artifact
   created through real intake is approvable but never countersigned into a
   resolvable release — `POST /v1/resolve` returns `no_release`.

Because of (2), a countersignable envelope can only be introduced today by
**seeding** the protocol-shaped envelope directly into the same Postgres the
server reads (Part B, clearly marked in the test). Everything after the seed —
approve, countersign, serving, resolution, verification, kill, feed — is real and
over HTTP.

**Live regression guard.** Part A ends by asserting that the DSSE-uploaded,
approved artifact resolves to `no_release`. **The day the envelope bridge lands,
that assertion FAILS** — a deliberate reminder to re-point Part A at a real
countersigned release and drop the seed in Part B.

`#19` and epic `#16` remain **open**: this is a partial (compose-driven + seeded)
proof, not the fully-CLI-driven chain, until `gridmason/cli#70` is resolved.

## Running it locally

Needs Docker with the Compose plugin, Node 20+, and the deps installed
(`npm ci`).

```sh
# 1. Bring up the backing stores (Postgres + object store) and create the bucket.
docker compose up -d postgres minio createbuckets

# 2. Apply the schema (config defaults target the compose published ports).
npm run migrate

# 3. Run the full chain.
npm run test:e2e

# 4. Tear down.
docker compose down -v
```

The e2e connects to Postgres at `localhost:5432` and the object store at
`localhost:9000` — the compose published ports, which are also the config loader's
defaults, so no environment overrides are needed. Override `DATABASE_URL` /
`OBJECT_STORE_*` (see [`config.md`](config.md)) to point at a different stack.
