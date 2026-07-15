# Full-chain e2e (FR-13)

The Phase-B-exit proof (SPEC §11): the whole registry works end to end — publish →
review → countersign → resolve + verify — driven **entirely by the real `gridmason`
binary** over **real HTTP** against a **compose-launched instance**, with the SPEC
§6/§10 failure modes (revoked artifact excluded, stale feed fail-closed) asserted,
not just the happy path.

The suite lives at [`test/e2e/full-chain.e2e.ts`](../test/e2e/full-chain.e2e.ts)
and runs under its own config ([`vitest.e2e.config.ts`](../vitest.e2e.config.ts))
so the fast unit run (`npm test`) stays infra-free. CI runs it as the dedicated
`full-chain-e2e` job ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

## What the instance under test is

The e2e boots the **real service** (`buildServer`, the same wiring
[`src/index.ts`](../src/index.ts) boots) in-process against the **R-E0 compose
stack's Postgres + object store**, and drives it over a real socket. The OIDC
issuer, reviewer roster, operator set, and countersign key are test-provided config
— exactly what a self-host operator provides at install
([`self-host/install.md`](self-host/install.md)) — and the transparency log is the
in-process `memory` log the compose default uses (injected so the host-side
inclusion check can read its checkpoint key). The serving origin
(`GET /v1/artifacts/:hash`) is exercised unchanged, never modified.

> The full **container** quickstart (image + Postgres + object store, `docker
> compose up --build`, trust-root generation, policy page) is separately smoke-
> tested by the `self-host-smoke` job. This e2e uses the documented "backing stores
> + run the service from the host" compose mode (see [`compose.yaml`](../compose.yaml))
> because the chain needs test-controlled OIDC config, and the loader accepts an
> `http://` issuer only on loopback.

## The chain, part by part — all real, all over HTTP

| Part | Steps |
|---|---|
| **A** | `gridmason widget init` scaffolds a widget → **`gridmason publish --signer ephemeral`** (real keyless sign + upload of the protocol `SignatureEnvelope`) → the registry's **real** automated review (the shared [`@gridmason/cli/checks`](review/automated.md)) → a reviewer approves over HTTP → the **real countersign stage** publishes a release |
| **B** | `POST /v1/resolve` → verify each URL with `@gridmason/protocol` `verifyRelease` + hash the byte-served entry → **kill → excluded** (SPEC §6) |
| **C** | fetch the signed revocation feed → authenticate with `verifyRevocationFeed` → `evaluateFreshness`: fresh (blocks the killed artifact) and **stale-past-TTL fail-closed** (SPEC §6, §10) |

Nothing is pre-seeded into the store: the artifact under resolution, kill, and feed
is the one the real `gridmason` binary published.

### The two asserted failure modes (the point of FR-13)

- **Revoked/killed excluded from resolution (fail closed for revocation).** Part B
  kills the approved, countersigned artifact through the operator ops endpoint and
  asserts `POST /v1/resolve` returns it in `excluded` (`not_distributable`), never
  in `imports`.
- **Stale feed past the 24 h TTL fails closed.** Part C runs the served,
  signature-authenticated feed through `evaluateFreshness` with a clock past
  `issuedAt + ttlSeconds` and asserts a `stale` (fail-closed) verdict.

## Blockers resolved — the chain is no longer partial

Earlier this suite was a **partial** proof: the countersign/resolve/verify legs were
covered by a *seeded* protocol-shaped envelope because the real chain was blocked by
two cross-repo gaps ([`gridmason/cli#70`](https://github.com/gridmason/cli/issues/70)).
Both shipped in **`@gridmason/cli@0.6.0`** + this registry change (registry#55):

1. **`gridmason publish` emits the protocol `SignatureEnvelope`** (was a bare DSSE
   object), and offers an **offline** keyless signer selectable from the binary —
   `publish --signer ephemeral` — so CI drives the real binary deterministically
   with no Sigstore network.
2. **Registry intake accepts the protocol envelope**
   ([`src/artifact/envelope.ts`](../src/artifact/envelope.ts) — via the countersign
   parser, so intake-accepted ⟹ countersign-parseable), so a real upload
   countersigns into a resolvable, verifiable release.

So the seeded legs and the `no_release` regression guard are gone; every leg is now
the real binary against the compose instance.

## Trust roots for the ephemeral signer (no production path weakened)

`publish --signer ephemeral` mints a **self-issued** keyless leaf — a dev/e2e
affordance, **not** a Fulcio identity — so its cert chains to nothing a production
host pins. The e2e's host-side `verifyRelease` therefore pins that leaf's **own
public key** as the publisher root, read off the resolved signature bundle, **in the
e2e's own trust-root config only** (exactly as a host pins a root it has chosen to
trust). No production verify path is changed to admit ephemeral certs: a real host
still pins real Fulcio roots and refuses the ephemeral leaf. The countersign root is
the instance's own countersign key (the same one that signs the revocation feed), and
the log key is the injected in-process log's checkpoint key.

## Running it locally

Needs Docker with the Compose plugin, Node 20+, and the deps installed (`npm ci`).

```sh
# 1. Bring up the backing stores (Postgres + object store) and create the bucket.
docker compose up -d postgres minio createbuckets

# 2. Apply the schema (config defaults target the compose published ports).
npm run migrate

# 3. Run the full chain (spawns the real `gridmason` binary from node_modules).
npm run test:e2e

# 4. Tear down.
docker compose down -v
```

The e2e connects to Postgres at `localhost:5432` and the object store at
`localhost:9000` — the compose published ports, which are also the config loader's
defaults, so no environment overrides are needed. Override `DATABASE_URL` /
`OBJECT_STORE_*` (see [`config.md`](config.md)) to point at a different stack.
