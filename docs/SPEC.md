# SPEC — Gridmason Registry

**Repo:** `gridmason/registry` · **Deliverable:** self-hostable service · **License:** AGPL-3.0 (CLA required) · **Status:** draft v0.2 · **Project:** [Gridmason](https://github.com/gridmason/.github) · **Flagship instance:** `registry.gridmason.dev` (GW-D10)

The federated module registry: the supply chain for every widget/plugin remote a Gridmason host loads at runtime. Hosts **signed, content-hashed ES-module remotes** (GW-D22) served immutably from a CDN — **the reviewed hash is the runnable artifact; publishers can't swap code post-review.**

Open source and self-hostable like the rest of Gridmason (GW-D10): any organization can run a private registry for its own widget ecosystem. The project operates the public **flagship instance** at `registry.gridmason.dev`. One rule holds for every instance: **a registry is supply chain, never a control plane** — hosts reach it over outbound 443 (or signed offline bundles) and keep working when it's unreachable.

## 1. Scope

**In:** publish pipeline, publisher records + identity tiers, review workflow (mechanism + flagship policy), dual signature + transparency log, content-hash CDN serving, dependency-DAG enforcement, gate/kill-switch integration, version sets, offline bundles, self-host story, publisher/ops APIs.

**Out:** module loading in the browser (host shell), payment/storefront (a host concern), npm package hosting (npm stays npm — this registry serves *runtime remotes*).

**Formats are the contract:** manifest schema, signature envelope, transparency-log entry, revocation-feed, trust-root document, and bundle format all live in **`@gridmason/protocol`** (GW-D6) — which also ships the public **verification library** hosts use (signature chain, hash, log-inclusion checks). Any conforming registry implementation interoperates.

## 2. Trust model

### Dual signature (load-bearing)

Every published version carries:

1. **Publisher signature** — authorship. Keyless by default (Sigstore-style short-lived signing cert bound to the publisher's OIDC identity at `gridmason publish` time). **The OIDC issuer is the real trust anchor**: each registry configures an explicit **issuer allowlist**, and the signing cert + log entry record the issuer and subject claims, so verifiers see exactly which identity vouched for the artifact. Optionally an issued cert (registry CA intermediate, 1y validity, overlap-window rotation, CRL/OCSP to all hosts ≤ 1h).
2. **Registry countersignature** — approval, applied **only after review passes**. The countersign key is held separately from review staff.

Hosts verify **both signatures + content hash + transparency-log inclusion** before load. A stolen publisher key alone cannot ship code to anyone.

### Transparency log

Sigstore-style, public, auditable — anyone can verify what a registry shipped. **The flagship anchors to the public Sigstore infrastructure (Fulcio for keyless certs, Rekor as the log) rather than operating its own CA/log (GW-D17)**; self-hosted registries bring their own countersign key, and log-inclusion is a policy-configurable verify check pre-1.0. Key-compromise path: revoke cert → log flags affected versions → fleet-wide kill-switch via the revocation feed → re-sign clean under a new key.

### Trust-root distribution & rotation

Hosts bootstrap trust from **pinned trust-root documents** (registry countersign root + publisher-CA roots + log public key), one per trusted registry. Two pinning channels, both security-critical:

1. **Build-time** — roots shipped inside the host application build (the default for registries known when the app is built, e.g. the flagship).
2. **Deploy-time** — an operator-supplied trust-root config (file/secret), so a deployer can trust a fresh self-hosted registry **without rebuilding the app**. Threat model: whoever writes this config can graft a registry into the deployment's supply chain — protect it like any credential (config-management access controls, change audit); it is never writable from the application UI.

Neither channel fetches roots blind at runtime. Rotation: new roots are published in the transparency log and cross-signed by the outgoing root with an overlap window (≥ one host release cycle); hosts accept either root during overlap and drop the old one on their next release/config update. Air-gapped hosts pin the same documents; they travel inside signed bundles. Format is public in `@gridmason/protocol`. Self-hosted registries generate their own roots at install.

### Registry-published widgets — separation of duties

Widgets published by a registry operator's own team ride the same pipeline as everyone else's: reviewed by a different person than the author, countersigned by the separately-held registry key. **Operators never self-approve.** (Recommended default for self-hosters; see §4a for the flagship's disclosed launch-phase waiver.)

## 3. Artifact model

- Upload = a separable, analyzable artifact: manifest + frontend remote (`entry` module + chunks) + schemas + docs.
- Bundles are **immutable and content-hashed**; the CDN serves by hash; the signed release lists the exact hashes the runtime may load.
- Reproducible builds required for tiers that ship executable content — **deferred to Phase C (GW-D19)**; until then TF review takes a signed source archive uploaded with the artifact (reviewer builds/spot-checks), and hash pinning alone guarantees served-bytes immutability.
- Offline/air-gap: signed `.gmb` bundle export, verified against pinned root keys; **transparency-log inclusion proofs are embedded in the bundle** so air-gapped hosts verify the identical chain (format finalized in `@gridmason/protocol`).

## 4. Review workflow

The *mechanism* is part of the platform; the *policy* (what a reviewer accepts) belongs to each registry operator. The flagship's policy is published — no secret rules — and `gridmason lint` runs the identical automated checks locally.

1. `gridmason publish` → automated review: malicious-code + **SDK-adherence analysis on the artifact** (raw network I/O outside the SDK, token reachability, obfuscation heuristics), manifest lint (incl. publisher-prefix check), **capability diff** (capability increases — and, for widgets holding sensitive capabilities, content/behaviour diffs — re-trigger review), dependency-DAG check.
2. Human review by trust tier:
   - **T1 — declarative**: no executable content (layouts, page types, dashboards). Flagship SLA 2d.
   - **TF — frontend remote**: plain-JS widget/plugin remotes — the common case. Reproducible build + SDK-adherence static analysis + DOM-abuse heuristics. Flagship SLA 5d.
   - **Reserved tiers** for sandboxed compute and container workloads — format hooks exist in the manifest; out of scope for v1.
   - Capability-increase re-review 3d; expedited security-patch lane 24h.
3. Pass → registry countersignature + transparency-log entry + CDN publish.
4. Appeals → a second reviewer (never the original).

### 4a. Flagship operations at launch (GW-D13)

**Revised by GW-D18:** the flagship opens **invite-only** (verified publishers) with a **single-person review roster**; open community publishing waits for roster ≥ 2 (Phase C, SCOPE). Consequences while single-rostered, disclosed rather than hidden:

- The §2 separation-of-duties rule is **waived for flagship operator-published widgets** until the roster reaches ≥ 2 reviewers; the waiver is stated on the published policy page and every affected release is flagged in its transparency-log entry.
- SLAs (T1 2d / TF 5d / security lane 24h) are **published targets, not guarantees**, until staffed; the policy page shows current actual review latency.
- Countersign-key custody procedure is documented before launch (offline key, distinct from the reviewer's publishing identity) even while both roles are one person.
- Self-hosters inherit none of this — each instance publishes its own policy page in the same format.

## 5. Publisher records

- Publisher identity tiers: **community** (account + email age) → **verified** (domain proof + legal entity + signed publisher agreement) → **operator** (the registry operator's own team, bound by §2 separation of duties).
- A record holds: identity tier, signing keys/cert chain, review history, published versions, and the publisher's **namespace prefix** (which widget `tag`s and package paths it may publish under).
- The publisher console (key management, review status, listings) is a thin UI over the publisher API — and is itself built from Gridmason widgets.

## 6. Gates, kill switch, revocation — ownership contract

Gate state has **two owners with one merge rule**, defined as a public format in `@gridmason/protocol`:

- **The registry owns distribution state** (published / revoked / killed) and publishes it as a **signed revocation & kill feed**.
- **Hosts own enablement state** (which widgets this deployment/org/user turned on) via their gate service — the core `gates` adapter is a consumer, not an authority, of distribution state.
- **Effective gate = registry distribution state ∧ host enablement.** Every conforming gate-service implementation MUST consume the feed; a killed remote never enters the import map regardless of local enablement.

Freshness is tracked **per registry**: a host trusting N registries keeps N feed cursors and N TTL clocks. Cached release documents and gate snapshots carry a **max TTL (24 h)**; past a registry's TTL, the host MUST re-check *that registry's* revocation feed before loading — **fail closed for revocation, scoped to that registry's remotes only**; remotes from still-fresh registries are unaffected, and everything else stays fail-open (registry down + TTL valid = keep working). Kill-feed propagation: ≤ 1 h online; air-gap = next bundle sync, prominently documented. Flagship severity policy: actively-exploited / credential-path → immediate kill + deployment notification within 24 h.

The registry records the exact version set each **deployment** runs (see §8) — canary %, rollback pointers — and publishes a named **stable version set** (widget/plugin versions verified to compose).

## 7. Dependency enforcement & format lifecycle

- Manifest `requires` graph must be a DAG — **the registry rejects circular `requires` at publish**.
- Publisher CI can check its `requires` graph against the registry pre-release (`gridmason lint --registry`).
- **Format versioning:** every protocol format (manifest, signature envelope, log entry, revocation feed, trust-root document, bundle) carries an explicit version field; the `@gridmason/protocol` verification lib declares which majors it speaks, so hosts and registries negotiate by version, never by guessing. Format evolution policy (deprecation windows, dual-running) is part of the M0 protocol deliverable.
- **Retirement is per-registry**: each operator declares when it stops *serving* artifacts pinned to a retired format major (a distribution-state decision, published with a dual-running window — the flagship's is public). The resolution API then refuses import-map fragments for those artifacts. Whether to also block *enablement* of already-cached ones remains the host's call (§6 ownership contract).

## 8. Service API (formats in `@gridmason/protocol`)

| Surface | Consumer | Highlights |
|---|---|---|
| Publish API | `gridmason` CLI | upload artifact, sign, review status, appeal |
| Resolution API | host shells | gate-snapshot → import-map fragment (hash-pinned remote URLs + signature bundle) |
| Verification API | hosts, auditors | log inclusion proofs, cert chains, CRL/OCSP, revocation feed |
| Publisher API | console | keys, listings, review history |
| Deployment API | host shells | deployment identity registration + version-set report — **strictly opt-in** (it buys canary/rollback participation and targeted kill notifications; the resolution API works anonymously, and a registry is never a control plane a deployment must phone) |
| Ops API | registry operator | kill switch, version sets, canary/rollback |

Runtime hot path is **CDN + cached signed release documents** — the registry API is never in a page-load's critical path (subject to the §6 revocation TTL).

## 9. Self-hosting

- **Implementation:** the service is **Node + TypeScript** (GW-D15) — one toolchain shared with `@gridmason/{protocol,core,sdk,cli}`, so the verification lib (protocol §5) and the review checks (shared with `cli lint`, §4.1) are the *same code* server-side and client-side, not a reimplementation. Lowest contributor barrier for an OSS project.
- Distribution: single **container image** + compose/Helm charts; storage = object store (bundles/CDN origin) + database (records/log); the transparency log is embeddable or external.
- A self-hosted instance is a full registry: own trust roots, own publisher records, own review policy. `gridmason publish --registry <url>` targets it.
- Hosts may trust multiple registries simultaneously (e.g. flagship + private). Publisher prefixes are unique only *within* a registry — there is no global prefix authority — so the host **pins each prefix to one registry** when merging import maps: a merged map in which two registries claim the same prefix is rejected as a configuration error, and widget instances resolve by source-qualified identity `(registry, publisher, tag)` (core spec §4). Flagship-`acme` and private-`acme` can coexist only under distinct pinned prefixes.
- The flagship runs the same released image — no proprietary fork.

## 10. NFRs

- CDN-served remotes: immutable, `Cache-Control: immutable`, hash-addressed.
- Registry API unavailability degrades to last-verified cached release docs **within the 24 h revocation TTL** (§6) — hosts keep working; past TTL, loading new/uncached remotes fails closed.
- Every state transition (publish, review, sign, gate flip, revoke) is an auditable event.

## 11. Milestones

1. **M1 — formats** (authored in `gridmason/protocol`, this repo drives them): manifest/signature/log-entry/revocation-feed/trust-root formats + the public verification lib; local verify in the `gridmason` CLI.
2. **M2 — publish + verify pipeline**: keyless signing, automated review checks, countersign, CDN publish, transparency log.
3. **M3 — resolution API + gates**: import-map fragments, kill switch, version sets.
4. **M4 — publisher records/console, review SLAs, offline bundles, self-host packaging.**
5. Exit: the Gridmason Dashboard loads a third-party-published widget end-to-end from a fresh self-hosted instance **and** from the flagship.
