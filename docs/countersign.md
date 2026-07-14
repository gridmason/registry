# Countersign + transparency logging

The final step of the publish pipeline (FR-5, FR-12; SPEC §2, §3, §4a). When a
human review passes, the registry applies its **approval** signature to the
publisher-signed artifact, anchors the result in a public **transparency log**,
and emits the signed **release document** a host loads. This document covers key
custody and the Sigstore public-instance dependency; the wire formats themselves
live in `@gridmason/protocol`.

## What the stage does

On the `reviewing → approved` transition (`src/review/human/lane.ts` fires the
`onApprove` hook), `src/countersign/stage.ts`:

1. **Binds** — reproduces the signed release document (`{ path → hash }`, SPEC §3)
   from the artifact's stored content hashes and checks it hashes to the subject
   the publisher signed. A drift is refused, never countersigned.
2. **Countersigns** — signs the publisher signature with the separately-held
   registry key, producing the protocol dual-signature envelope
   (`verifySignatureEnvelope` then accepts both signatures).
3. **Anchors** — appends the release to the transparency log. A release approved
   under the flagship self-review waiver (SPEC §4a) is flagged in the logged leaf.
4. **Emits** — persists the `ReleaseDoc` (file map + completed envelope + the full
   Rekor-shaped inclusion entry) to `release_doc`, for the serving surface (#12).
5. **Audits** — `release.countersigned` for the signature and `release.logged`
   for the emission (FR-12), both under the `registry:countersign` actor — never a
   reviewer identity.

The acceptance bar: the resulting envelope verifies via `@gridmason/protocol` —
both signatures, the content-hash binding, and log inclusion
(`test/countersign/verify.int.test.ts`).

## Key custody (SPEC §2, §4a)

**The countersign key is held separately from review staff.** In this codebase
that separation is structural: the key is loaded only from its own
custody-controlled config fields — `COUNTERSIGN_PRIVATE_KEY` and
`COUNTERSIGN_CERTIFICATE` (`src/countersign/identity.ts`) — which are distinct
from the reviewer roster (`REVIEW_REVIEWER_IDENTITIES`). The countersign path
never reads a review-lane credential, so a reviewer identity can never become the
signing key.

- **Algorithm:** ECDSA **P-256 / SHA-256** (`ES256`) — the only algorithm the
  protocol verify lib accepts at format `1.x`. A key on any other curve is refused
  at boot.
- **Provisioning:** the key and its X.509 certificate are generated **offline**
  (SPEC §4a: "offline key, distinct from the reviewer's publishing identity") and
  projected into the process as secrets — env vars or a secret-manager mount. They
  are never written from the application UI.
- **Failure is loud:** a configured-but-unusable key (bad PEM, wrong curve, a
  certificate that does not match the key) fails at boot rather than silently
  skipping countersign and shipping unapproved releases. An instance with **no**
  countersign key configured simply does not mount the stage (approvals record a
  verdict without publishing a release — the Phase-A author-loop shape).

### Generating a self-signed countersign key (self-hosters)

A self-hosted registry brings its own countersign key; hosts pin its certificate's
public key as a countersign root. An offline example:

```sh
# P-256 private key (custody-controlled; store as COUNTERSIGN_PRIVATE_KEY)
openssl ecparam -name prime256v1 -genkey -noout -out countersign.key
# Self-signed certificate (store as COUNTERSIGN_CERTIFICATE)
openssl req -x509 -new -key countersign.key -days 365 \
  -subj "/CN=registry.example countersign" -out countersign.crt
# The public key hosts pin as the countersign root:
openssl x509 -in countersign.crt -pubkey -noout
```

Keep `countersign.key` offline; project only the two PEMs into the running
service. Rotation follows SPEC §4.4 (publish an overlap trust-root document
cross-signed by the outgoing root).

## Transparency log — Sigstore public-instance dependency (GW-D17)

Per GW-D17 the flagship **anchors to the public Sigstore infrastructure (Rekor)**
rather than operating its own log. `src/sigstore/` provides one
`TransparencyLog` interface with two implementations, selected by
`TRANSPARENCY_LOG_DRIVER`:

- `rekor` — `RekorTransparencyLog`, a real HTTP client against the configured
  Rekor instance (default `https://rekor.sigstore.dev`). Production.
- `memory` — `InMemoryTransparencyLog`, a faithful in-process RFC 6962 log with an
  Ed25519-signed c2sp checkpoint. Its entries verify against the protocol
  `verifyLogInclusion` unchanged, so it backs dev and tests.

### Evaluation of the public-instance dependency

The SPEC's open question ("Sigstore public-instance dependency — rate limits,
availability") evaluated here:

- **Availability is on the countersign critical path.** Anchoring is synchronous
  with approval: if the public Rekor instance is unreachable or rate-limits the
  submission, the stage records `log-append-failed` and **does not** mark the
  release logged (fail-closed — an un-anchored release is never published as
  though it were). The approval verdict still stands; the release simply is not
  emitted until anchoring succeeds.
- **Rate limits.** The public instance applies per-client rate limits. At launch
  volumes (invite-only, single-rostered — SPEC §4a) this is comfortably within
  limits; it becomes a concern only at open-publishing scale.
- **Trust.** Anchoring to the public log means the registry does not run its own
  CA/log to trust — the intended GW-D17 trade — at the cost of depending on that
  log's uptime and honesty (mitigated because hosts verify inclusion against a
  **pinned** log key, so a substituted log is refused).

### Fallback is Phase C (not built here)

The mitigation for public-instance unavailability is a **self-hosted Rekor** the
registry runs itself. That is a **Phase C** item and is deliberately **not** built
in this cut (SCOPE): the interface makes it a drop-in third implementation later,
but no self-hosted-log code ships now.
