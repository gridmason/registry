# Artifact status + appeal API

The publisher-facing review surface (FR-11; SPEC §4). It is what the `gridmason`
CLI calls **after** an upload: `gridmason publish` polls the review outcome and
prints a rejection's findings, and `gridmason appeal` routes a rejected
submission to a second reviewer. The upload itself is the [Publish
API](./publish.md); this is the status + appeal half of the same flow.

- `GET  /v1/artifacts/:id/status` — the artifact's review state + findings.
- `POST /v1/artifacts/:id/appeal` — re-open a rejected artifact for a second reviewer.

> **Path note (CLI contract deviation).** The CLI's forward contract (cli PR #63)
> polls status at `GET /v1/artifacts/:id`. That bare path is already taken by the
> frozen [hash-addressed serving origin](../serving.md) `GET /v1/artifacts/:hash`
> (FR-6) — two `GET` handlers cannot share the `/v1/artifacts/:param` template — so
> the registry serves publisher status at **`GET /v1/artifacts/:id/status`**. The
> appeal endpoint keeps the CLI's exact path (its `/appeal` suffix does not
> collide). The CLI's status poll must move to `/v1/artifacts/:id/status` in its
> next bump; until then, a poll of `/v1/artifacts/:id` reaches the serving origin
> and gets `404 unknown_hash`.

## Identity + authorization (owner-scoped)

Both endpoints present a bearer token, verified exactly as the Publish API
verifies it (OIDC discovery → JWKS signature check, allowlisted issuers,
asymmetric algorithms only, fail-closed) — see [`publisher.md`](./publisher.md).
On top of verification they are **owner-scoped**:

1. **Registered publisher.** The verified `(issuer, subject)` must own a publisher
   record, else `403 not_registered`.
2. **Owns the artifact.** `:id` must be an artifact belonging to that publisher.
   A missing artifact **and** one owned by a different publisher are answered
   identically — `404 not_found` — so the endpoint is not an enumeration oracle
   for another publisher's artifact ids.

A request with no bearer token is `401 missing_token`; a token that fails
verification maps to the shared [OIDC error responses](./publisher.md).

## `GET /v1/artifacts/:id/status` — review status + findings

Returns the source-qualified artifact record (the same projection the upload
returns) plus, when the review carried anything actionable, a `review` object:

```jsonc
{
  "id": "…",
  "registryId": "registry.local",
  "publisherId": "…",
  "tag": "acme-clock",
  "version": "1.2.0",
  "state": "rejected",          // submitted | reviewing | approved | rejected | revoked | killed
  "contentHashes": { "manifest.json": "sha2-256:…", "entry.js": "sha2-256:…" },
  "sourceArchiveRef": "sha2-256:…",
  "createdAt": "2026-07-14T00:00:00.000Z",
  "review": {
    "results":  [ { "id": "sdk.raw-network", "status": "fail", "message": "raw fetch() outside the SDK" } ],
    "findings": [ { "checkId": "manual", "detail": "undisclosed telemetry" } ]
  }
}
```

`state` is the artifact's lifecycle state verbatim — a poller treats `approved`
and `rejected` as terminal and `submitted`/`reviewing` as still-in-flight.

The `review` object is **present only when there is something to report** and
carries up to two arrays, both keyed by the shared `@gridmason/cli/checks` check
ids (the same vocabulary local `gridmason lint` prints):

| Field | Source | Shape |
|---|---|---|
| `results` | the automated report's **non-`pass`** check results | `{ id, status, message }` — `status` is `warn`/`fail` |
| `findings` | a human reviewer's recorded findings (present once a case is decided) | `{ checkId, detail }` — `checkId` is a report check id or the `manual` sentinel |

An automated rejection carries `results` (the failing checks); a human decision
carries `findings`; a clean, undecided artifact (or a clean approval) carries no
`review` object at all. The two together are the union of the automated and human
findings a rejection can produce.

A status read is **not** audited: `publish` polls it in a loop, and a read is not
a registry state transition (SPEC §10 audits transitions). Authenticated denials
(bad token, non-owner, unregistered) do emit an `artifact.status.denied` event.

## `POST /v1/artifacts/:id/appeal` — route a second review

Re-opens a **rejected** artifact for human review by a *second* reviewer — never
the original (SPEC §4). The request body is empty (`{}`). On success the artifact
returns to `reviewing` and the response echoes its record:

```jsonc
{ "id": "…", "registryId": "registry.local", "tag": "acme-clock", "version": "1.2.0", "state": "reviewing", … }
```

Because a decided review case is never re-decided, an appeal opens a **new**
review case for the artifact, carrying the original automated report (so the
second reviewer's findings still map to the same check ids) and recording the
reviewer who cast the original rejection as the case's **excluded reviewer**. When
a verdict is later submitted, the [human review lane](../review/human-lane.md)
refuses it from that identity (`403 appeal_reviewer_forbidden`) — on top of the
standing reviewer ≠ author rule. An automated (`system`) rejection has no human
reviewer to exclude, so any reviewer ≠ author may take the appeal.

A successful appeal emits an `artifact.appeal` audit event (actor = the publisher
identity, subject = the artifact id); denials emit `artifact.appeal.denied`.

## Responses

### `GET /v1/artifacts/:id/status`

| Status | `error.code` | When |
|---|---|---|
| `200` | — | the artifact record (+ `review` when findings exist) |
| `401` | `missing_token` | no bearer token |
| `401` | `invalid_token` / `token_expired` / `token_not_yet_valid` | token rejected |
| `403` | `issuer_not_allowed` / `audience_not_allowed` | token issuer/audience rejected |
| `403` | `not_registered` | the verified identity owns no publisher record |
| `404` | `not_found` | unknown id, or an artifact owned by a different publisher |
| `503` | `verification_unavailable` | the issuer could not be reached (retryable) |

### `POST /v1/artifacts/:id/appeal`

| Status | `error.code` | When |
|---|---|---|
| `201` | — | re-opened; body is the artifact record, now `reviewing` |
| `401` / `403` / `404` | (as above) | same authentication + owner-scoping as the status read |
| `409` | `not_appealable` | the artifact is not `rejected` |
| `409` | `appeal_unavailable` | integrity fault — the rejected artifact has no review case to appeal |
| `409` | `transition_failed` | the artifact left `rejected` concurrently (a revoke/kill) before the re-open applied |

## Error body

Every non-2xx response carries the uniform body
`{ "error": { "code": "…", "message": "…" } }`.
