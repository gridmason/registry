---
name: Gridmason Registry v0
slug: registry-v0
status: approved
created: 2026-07-13
approved: 2026-07-13
---

# Gridmason Registry v0

## Overview

The Gridmason Registry is the signed supply chain for widget remotes: publish pipeline, review workflow, dual signature (Sigstore-anchored, GW-D17), hash-addressed CDN serving, resolution API, and the signed revocation/kill feed. Self-hostable; the flagship at `registry.gridmason.dev` runs the same released image, invite-only publishing until the review roster ≥ 2 (GW-D18).

Full engineering spec: [`docs/SPEC.md`](../../SPEC.md). **All Phase B** — and deliberately the SCOPE-minimal cut: publish → automated checks → one human review lane → countersign → serve → resolve → revoke. Cut from this round (Phase C, do not build): publisher console UI, version sets, canary/rollback, deployment API, offline-bundle serving, tiered review + SLAs, capability-diff automation, reproducible builds (GW-D19).

## Goals

- The dashboard loads a third-party-published widget end to end from a fresh self-hosted instance and from the flagship.
- A registry is supply chain, never a control plane: hosts keep working when it's unreachable (within the 24 h revocation TTL).
- The automated review checks are the CLI's `src/checks` module imported — zero divergence.

## Non-goals

- Everything on the Phase-C cut list above. Payment/storefront. npm hosting. Browser loading (host shell).

## Users & personas

- **Widget publishers** — publish via the CLI (no console UI this phase; status via CLI polling).
- **The reviewer** (single-person roster, disclosed) — review queue via minimal ops endpoints + CLI tooling.
- **Host operators** — trust-root pinning, resolution API, revocation feed.

## Functional requirements

- **FR-1** Publish API: immutable content-hashed artifact upload (manifest + `entry` + chunks + schemas + docs + signed source archive per GW-D19), publisher signature envelope attached (SPEC §3, §8).
- **FR-2** Publisher records: identity (OIDC-bound), namespace prefix ownership, published versions, review history — table + API, no console (SPEC §5, SCOPE cut).
- **FR-3** Automated review: the CLI shared-checks module (manifest lint, SDK adherence, DAG acyclicity — reject circular `requires` at publish) (SPEC §4, §7).
- **FR-4** One human review lane with approve/reject + findings mapped to check ids; reviewer ≠ author enforced except the disclosed flagship waiver (SPEC §4, §4a).
- **FR-5** Countersign on pass: registry key held separately from review staff; Sigstore-anchored transparency logging (Rekor) per GW-D17 (SPEC §2).
- **FR-6** Hash-addressed serving: object-store origin, `Cache-Control: immutable`, signed release documents listing `{path → hash}` (SPEC §3, §10).
- **FR-7** Resolution API: gate-snapshot → import-map fragment (hash-pinned URLs + signature bundle + `scopes` for shared-dep majors per GW-D22); works anonymously (SPEC §8).
- **FR-8** Signed revocation & kill feed: monotonic `seq`, TTL, revoke/kill states; kill propagation ≤ 1 h online (SPEC §6).
- **FR-9** Trust-root generation at install + rotation procedure documented (manual this phase, SCOPE cut) (SPEC §2).
- **FR-10** Multi-registry rules honored in outputs: publisher prefixes unique per registry; resolution output carries registry id for source-qualified identity (SPEC §9).
- **FR-11** Self-host distribution: single container image + compose file (Helm = stretch), object store + database, policy-page template (invite-only variant included) (SPEC §9, §4a).
- **FR-12** Every state transition (publish, review, sign, revoke) is an auditable event (SPEC §10).
- **FR-13** e2e proof: CLI publish → review → countersign → dashboard resolve + verify, against a compose-launched instance.

## Architecture & stack

Node + TypeScript service (GW-D15), one toolchain with the rest of the org; imports `@gridmason/protocol` (formats + verify) and the CLI `src/checks` package. Storage: Postgres (records, review queue, audit log) + S3-compatible object store (artifacts, release docs, feeds). Sigstore public infra (Fulcio + Rekor) for signing anchors. No proprietary fork for the flagship.

## Data model

- **Publisher** (id, oidc identity, prefix, tier, created)
- **Artifact** (id, publisher, tag, version, content hashes, source-archive ref, state: submitted|reviewing|approved|rejected|revoked|killed)
- **ReviewCase** (artifact, checks report, reviewer, verdict, findings, timestamps)
- **ReleaseDoc** (artifact, {path→hash}, envelope, log ref)
- **FeedEntry** (seq, artifact, state, severity, reason, issuedAt)
- **AuditEvent** (actor, action, subject, at)

## Screens & UX

None this phase (console = Phase C). Policy page = static template shipped in-repo.

## Epics & issues

### Epic: R-E0 Bootstrap
Goal: runnable empty service in a container with CI.
Depends on: protocol P-E3 on npm; cli L-E2 checks module published

- [ ] Service skeleton: HTTP framework, config, health, structured logging, CI
      FRs: FR-12 (audit plumbing)
      Acceptance: container builds + healthcheck green in CI
- [ ] Storage layer: Postgres migrations for the data model + S3 client + local dev compose (minio+postgres)
      FRs: FR-2, FR-12
      Acceptance: migrations idempotent; compose up → service connects
      Depends on: Service skeleton
- [ ] Community files + policy-page template (flagship invite-only variant + self-host variant)
      FRs: FR-11
      Acceptance: policy template renders both variants; CLA gate active
      Depends on: Service skeleton

### Epic: R-E1 Publish pipeline (Phase B)
Goal: upload → automated checks → human lane → countersign → logged.
Depends on: R-E0

- [ ] Publisher records + prefix registration API (OIDC-bound)
      FRs: FR-2, FR-10
      Acceptance: prefix uniqueness enforced per registry; identity recorded from OIDC claims
- [ ] Publish API: artifact upload, content-hash computation, immutability, envelope intake
      FRs: FR-1
      Acceptance: re-upload of same version refused; hashes match protocol vectors
      Depends on: Publisher records
- [ ] Automated review stage: import CLI checks module, persist report
      FRs: FR-3
      Acceptance: same fixture suite as CLI lint produces identical reports (shared-code proof)
      Depends on: Publish API
- [ ] Human review lane: queue endpoints, verdict + findings, reviewer≠author rule (+ disclosed waiver flag)
      FRs: FR-4
      Acceptance: self-review blocked unless waiver flag on; findings map to check ids
      Depends on: Automated review stage
- [ ] Countersign + transparency logging: separately-held key, Rekor anchoring, release-doc emission
      FRs: FR-5, FR-12
      Acceptance: approved artifact's envelope verifies via `@gridmason/protocol` incl. log inclusion
      Depends on: Human review lane

### Epic: R-E2 Distribution (Phase B)
Goal: hosts resolve, load, and revoke.
Depends on: R-E1

- [ ] Hash-addressed artifact serving (object-store origin + immutable cache headers)
      FRs: FR-6
      Acceptance: served bytes hash-match release doc; mutation attempt impossible via API surface
- [ ] Resolution API: import-map fragments + signature bundles + sharedScope `scopes` resolution
      FRs: FR-7, FR-10
      Acceptance: dashboard consumes fragment and verifies every URL; anonymous access works
- [ ] Revocation & kill feed: signed, monotonic, TTL semantics
      FRs: FR-8
      Acceptance: kill flips feed within one cycle; protocol `evaluateFreshness` accepts the feed
- [ ] Audit-event completeness pass
      FRs: FR-12
      Acceptance: every FR-1..8 state transition emits an event; audit query endpoint returns them

### Epic: R-E3 Self-host + e2e (Phase B exit)
Goal: anyone can run it; the whole chain proves out.
Depends on: R-E2

- [ ] Install story: trust-root generation, config reference, compose quickstart docs
      FRs: FR-9, FR-11
      Acceptance: fresh-machine quickstart reaches a publishable instance in documented steps
- [ ] Rotation + key-custody runbook (manual procedure, SCOPE cut)
      FRs: FR-9
      Acceptance: runbook walks overlap-window rotation against a test instance
- [ ] Full-chain e2e: CLI publish → review → countersign → dashboard resolves + loads (CI job with compose)
      FRs: FR-13
      Acceptance: e2e green in CI; failure modes (revoked artifact, stale feed) asserted

## Milestones

1. **M-B1:** R-E0 + R-E1 — publish pipeline lands artifacts reviewed + countersigned.
2. **M-B2 (repo exit):** R-E2 + R-E3 — flagship-deployable; dashboard e2e green. Phase B exit for the whole project.

## Risks & open questions

- Flagship run cost (CDN, object store, domain) — one-page budget required before go-live (SCOPE gap register).
- ToS/DMCA/abuse policy needed once invite-only publishing starts — legal text, tracked in SCOPE, not an engineering issue.
- Sigstore public-instance dependency (rate limits, availability) for countersign anchoring — evaluate in R-E1 issue 5; fallback = self-hosted Rekor later (Phase C).

## Changelog

- 2026-07-13 — initial draft from the approved engineering spec set (SCOPE-minimal Phase B cut).
