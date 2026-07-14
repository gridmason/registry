# Revocation & kill feed

The signed revocation & kill feed (FR-8; SPEC §6, §10). The registry owns
**distribution state** — whether an artifact it has already published is still
loadable — and publishes it as a signed, monotonic feed hosts poll. This is the
registry's half of the §6 ownership contract; it is **not** a control plane.

## Ownership boundary (read this first)

> **Effective gate = registry distribution state ∧ host enablement.** (SPEC §6)

- **The registry owns distribution state**: `published` → `revoked` → `killed`. It
  publishes that state in this feed and excludes non-distributable artifacts from
  its own resolution output. It never reaches into a host.
- **Hosts own enablement** (which widgets a deployment turned on) via their gate
  service. Every conforming gate service MUST consume this feed; a killed remote
  never enters the import map regardless of local enablement.

The registry is supply chain, never a control plane (SPEC §1): a host is not
required to phone home. It caches the feed and re-checks on its own TTL clock.

## States

| State | Meaning | Effect on a host |
|---|---|---|
| `revoked` | The artifact is withdrawn. | Block **new** loads. Running instances are left alone. |
| `killed` | Kill switch. Strictly more severe than `revoked`. | Block new loads **and** force-unload running instances. |

Each entry also carries an advisory **severity** (`low` / `medium` / `high` /
`critical`) and a human **reason**. Severity is triage metadata for how a host
surfaces the event — it does **not** change the load decision (any listed artifact
is blocked whatever its severity). Flagship policy: an actively-exploited or
credential-path artifact is an immediate `kill` at `critical`.

Valid transitions: `approved → revoked`, `approved → killed`, and the escalation
`revoked → killed`. Re-issuing against an artifact that is not in a distributable
state (never approved, or already killed) is refused.

## Freshness & TTL semantics

Freshness is tracked **per registry**: a host trusting N registries keeps N feed
cursors and N TTL clocks. The feed carries everything a host needs for the decision
(`@gridmason/protocol`'s `RevocationFeed` + `evaluateFreshness`):

- **`seq`** — a monotonic feed version, assigned by the database
  (`GENERATED ALWAYS AS IDENTITY`, migration 0001). It only ever increases. A feed
  whose `seq` is **below** the host's stored cursor is a replayed older feed and is
  rejected as a rollback, regardless of its TTL. An empty feed is `seq: 0` (a valid
  "nothing revoked" feed); a host that has never seen this registry starts its
  cursor at `-1`.
- **`issuedAt`** (epoch ms) + **`ttlSeconds`** — the freshness window. While `now`
  is within `issuedAt + ttlSeconds*1000` the registry is **fresh** and its remotes
  may load, minus the artifacts the feed blocks. Once `now` is past that window the
  feed is **stale**: the host MUST re-check *this registry's* feed before loading
  *its* remotes — **fail closed for revocation, scoped to this registry only**.
  Remotes from still-fresh registries are unaffected, and a reachable-but-fresh
  registry that is momentarily down keeps working (fail-open within TTL).

Max TTL is **24 h** (SPEC §6). The default served TTL is **1 h**
(`REVOCATION_FEED_TTL_SECONDS`) so a kill propagates within the §6 online bound
(≤ 1 h): the feed is generated live per fetch with the current `seq`, so a kill is
reflected on the very next poll and a host re-checks at least hourly.

## Signature

The served document is the protocol `RevocationFeed` plus a detached registry
signature over its **canonical bytes** (JCS / RFC-8785):

```jsonc
{
  "feed": { "formatVersion": "1.0", "registryId": "…", "seq": 3,
            "issuedAt": 1720000000000, "ttlSeconds": 3600,
            "entries": [ { "artifact": "acme-clock@1.2.0", "state": "killed",
                           "severity": "critical", "reason": "…" } ] },
  "signature": { "alg": "ES256", "cert": "<base64 DER cert>", "sig": "<base64 sig>" }
}
```

The signature is ECDSA P-256 / SHA-256 (IEEE-P1363 form) over `canonicalize(feed)`,
produced with the **same countersign key** the registry uses to approve releases
(SPEC §6) — so a host pins one countersign root and verifies both. A host
reconstructs the canonical bytes from the `feed` it received, checks the signature
against its pinned root, then passes `feed` to `evaluateFreshness`.

## Endpoints

### `GET /v1/revocation/feed` — anonymous

Returns the current signed feed. No authentication: distribution state is public
(like the resolution surface). Generated live, so it always reflects the latest
transition.

### `POST /v1/ops/artifacts/:id/revoke` — operator only
### `POST /v1/ops/artifacts/:id/kill` — operator only

Issue a revoke/kill. The SCOPE-minimal Ops API (no console): a bearer token must
verify against an allowlisted OIDC issuer (SPEC §2) **and** name an identity in
`OPS_OPERATOR_IDENTITIES`.

Body:

```json
{ "severity": "critical", "reason": "actively exploited credential path" }
```

`severity` is one of `low` / `medium` / `high` / `critical`; `reason` is a
non-empty string. On success the artifact transitions, a `FeedEntry` is appended
(bumping `seq`), and an `AuditEvent` is emitted (`artifact.revoked` /
`artifact.killed`, actor = the operator). Response:

```json
{ "artifactId": "…", "artifactState": "killed", "state": "killed", "seq": 1 }
```

| Status | When |
|---|---|
| `201` | Revoked/killed. |
| `400 invalid_request` | Missing/invalid `severity` or empty `reason`. |
| `401 missing_token` | No bearer token. |
| `403 not_an_operator` | A verified identity that is not on the operator set. |
| `404 not_found` | No artifact with that id. |
| `409 invalid_state` | The artifact is not distributable (never approved, or already killed). |

## Exclusion from resolution

A revoke/kill moves the artifact out of the `approved` state, so it drops out of
the registry's approved-only resolution-candidate set — a killed remote never
enters an import-map fragment at the source. For hosts that already hold a cached
release document, the feed is the second line: `evaluateFreshness` returns the
artifact in its `blocked` list (with `state: "killed"` so the host also unloads it).
Together these keep a killed remote out of every import map.

## Audit

Every revoke/kill emits an `AuditEvent` (FR-12): the operator identity as `actor`,
`artifact.revoked` / `artifact.killed` as `action`, the artifact id as `subject`.
Denied ops requests emit `ops.denied`.
