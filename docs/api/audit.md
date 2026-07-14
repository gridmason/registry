# Audit log

Every registry state transition is an auditable event (FR-12; SPEC §10). The
registry records an `AuditEvent` for each transition through a pluggable audit
sink (logged for observability **and** persisted to the `audit_event` table), and
exposes an operator-gated query endpoint to read the trail back. This is the
cross-cutting guarantee that the registry is fully auditable: no state transition
is silent, and the trail is retrievable.

## The `AuditEvent` shape

Every event carries four fields (the `audit_event` row):

| Field | Meaning |
|---|---|
| `actor` | Who caused the transition — a publisher/reviewer/operator identity (`composeOidcIdentity` form), or `system` / `registry:countersign` / `anonymous` for registry-driven and pre-auth transitions. |
| `action` | The transition verb (see the matrix below). |
| `subject` | What it acted on — usually the artifact id, a `registry/prefix`, or a source-qualified widget id. |
| `at` | When it happened (UTC). |

Events are never mutated or deleted; the table is append-only. The durable write is
best-effort and **never blocks or fails the transition that produced it** — an audit
outage degrades observability, it does not stop the registry.

## Audited transitions (the completeness matrix)

Every FR-1..8 state transition emits exactly one event. A test
(`test/audit/completeness.test.ts`) walks the whole pipeline and asserts one event
per transition, so a future change that adds a transition without an audit event
fails CI.

| FR | Transition | `action` | Typical `actor` |
|---|---|---|---|
| FR-2 | Publisher registration | `publisher.register` | publisher |
| FR-2 | Prefix claim | `prefix.claim` | publisher |
| FR-2 | Registration denied | `publisher.register.denied` | `anonymous` |
| FR-1 | Publish intake accepted | `publish.submitted` | publisher |
| FR-1 | Publish intake denied | `publish.denied` | publisher / `anonymous` |
| FR-3 | Automated review → `reviewing` | `review.reviewing` | `system` |
| FR-3 | Automated review → `rejected` | `review.rejected` | `system` |
| FR-4 | Human verdict → `approved` | `review.approved` | reviewer |
| FR-4 | Human verdict → `rejected` | `review.rejected` | reviewer |
| FR-4 | Self-review waiver used (SPEC §4a) | `review.waiver` | reviewer |
| FR-4 | Human verdict denied | `review.denied` | reviewer / `anonymous` |
| FR-5 | Countersignature applied | `release.countersigned` | `registry:countersign` |
| FR-5 | Release anchored in the transparency log **and** persisted (published) | `release.logged` | `registry:countersign` |
| FR-5 | Transparency-log append failed after retries (#38) | `release.log_failed` | `registry:countersign` |
| FR-5 | Release doc could not be persisted after signing + logging (#38) | `release.persist_failed` | `registry:countersign` |
| FR-8 | Revoke | `artifact.revoked` | operator |
| FR-8 | Kill | `artifact.killed` | operator |
| FR-8 | Ops action denied | `ops.denied` | operator / `anonymous` |
| — | Service start | `service.start` | `system` |

### Countersign (FR-5) event semantics

The countersign stage emits `release.countersigned` at the moment of **signing** —
it records the signing *act*, not publication — and only later emits
`release.logged` once the release is both anchored in the transparency log **and**
persisted (i.e. actually published). So `release.countersigned` without a following
`release.logged` is expected and unambiguous: exactly one of two failure events
then explains why publication did not complete —

- `release.log_failed` — the transparency-log append failed after bounded retries;
- `release.persist_failed` — the append succeeded but the release doc did not persist.

Either failure leaves the artifact **approved-but-unpublished** (no release doc);
the re-drive endpoint (below / see `docs/config.md`) picks up any approved artifact
lacking a release doc and completes it. The two failure events cover every
non-published outcome, so the trail is never silent about a signed-but-unpublished
artifact.

### Read surfaces emit no per-request event

Serving (FR-6) and resolution (FR-7) are **hot-path reads**, not state transitions —
the registry API is never in a page-load's critical path (SPEC §10). They deliberately
emit **no** per-request audit event: the trail records state changes, not reads. The
audit-query endpoint itself is a read surface for the same reason and emits no event
either (only its auth denials are audited, as `ops.denied`).

## Query endpoint

```
GET /v1/ops/audit
```

**Operator-only.** Authenticate with a bearer token that (1) verifies against an
allowlisted OIDC issuer (SPEC §2) and (2) names an identity in
`OPS_OPERATOR_IDENTITIES` — the same operator set as the revocation ops endpoints.
A missing token is `401`; a verified non-operator is `403 not_an_operator`.

### Query parameters

All filters are optional and AND-combined.

| Param | Meaning |
|---|---|
| `subject` | Exact-match subject. |
| `action` | Exact-match action. |
| `since` | ISO-8601 instant; only events at or after it (inclusive). |
| `until` | ISO-8601 instant; only events at or before it (inclusive). |
| `limit` | Page size. Defaults to 50, clamped to a max of 500. |
| `before` | Keyset cursor: only events with an id strictly less than this. |

A malformed `since`/`until` (not ISO-8601) or a negative/non-integer `before`/`limit`
is `400 invalid_request`.

### Response

Events are returned **newest-first**:

```json
{
  "events": [
    { "id": 42, "actor": "…", "action": "review.approved", "subject": "…", "at": "2026-07-14T12:00:00.000Z" }
  ],
  "nextBefore": 41
}
```

`nextBefore` is the cursor for the next (older) page, or `null` when the trail has
been exhausted. Page forward by passing it back as `before`:

```
GET /v1/ops/audit?limit=100
GET /v1/ops/audit?limit=100&before=<nextBefore>
```

A short page (fewer than `limit` events) always closes the cursor (`nextBefore:
null`).

## Configuration

The query endpoint mounts wherever the publisher surface does (it shares the OIDC
verifier). The operator set is `OPS_OPERATOR_IDENTITIES` (see `docs/config.md`). The
durable audit sink writes to the `audit_event` table over the configured Postgres
connection; with no database wired (e.g. a test), an in-memory store backs both the
sink and the query endpoint.
