# Human review lane

The single human review lane acts on the artifacts the
[automated stage](./automated.md) advanced to `reviewing`. A reviewer lists the
queue, reads a case's automated checks report, and records a **verdict** —
`approve` or `reject` — with **findings** that map to the report's check ids. It
satisfies **FR-4** and SPEC §4, §4a.

This is the **one** review lane the SCOPE-minimal Phase B cut ships. It is
**not** the T1/TF trust-tier ladder with SLAs (that is flagship policy / Phase C),
there is no reviewer console (CLI/API only this phase), and appeals — the "second
reviewer" path of SPEC §4 — are out of scope beyond the reviewer≠author rule.

## Endpoints

All three endpoints are **reviewer-only**: this is operational data ahead of
approval, not the public resolution surface. A request must carry a bearer token
that (1) verifies against an allowlisted OIDC issuer (SPEC §2) and (2) names an
identity in this registry's configured [reviewer set](#reviewer-set). A token
failure maps to the shared OIDC error responses; a verified identity that is not
a reviewer gets `403 not_a_reviewer`.

### `GET /v1/review/queue`

The artifacts awaiting a human verdict — every artifact in `reviewing` whose
review case is undecided — oldest first. Each item carries the artifact
(source-qualified) and a **summary** of its automated report:

```json
{
  "cases": [
    {
      "caseId": "…",
      "createdAt": "2026-07-14T12:00:00.000Z",
      "artifact": { "id": "…", "registryId": "registry.test", "tag": "acme-clock", "version": "1.2.0", "state": "reviewing", "…": "…" },
      "checks": {
        "status": "pass",
        "module": "@gridmason/cli/checks",
        "version": "0.0.3",
        "checkIds": ["manual", "manifest.schema", "sdk.raw-network", "…"]
      }
    }
  ]
}
```

`checks.checkIds` is exactly the set a finding may reference: every check id in
the report, plus the `manual` sentinel.

### `GET /v1/review/cases/:id`

One case with the **full** automated report (`report.results` — every check
result verbatim from the shared module) and the recorded `verdict` (`null` while
the case is pending). A `404` means no case has that id.

### `POST /v1/review/cases/:id/verdict`

Record the verdict. Body:

```json
{
  "decision": "approve",
  "findings": [
    { "checkId": "manifest.schema", "detail": "schema is clean" },
    { "checkId": "manual", "detail": "reviewed the network calls by hand" }
  ]
}
```

- `decision` — `"approve"` or `"reject"` (required).
- `findings` — an array (may be empty for a clean approval). Each finding's
  `checkId` **must** be a check id present in the case's automated report, or the
  literal `"manual"` for a judgement the reviewer made by hand; `detail` is the
  reviewer's non-empty note. A finding referencing a check id that is not in the
  report is refused with `422 unknown_check_id`.

On success (`201`):

```json
{ "caseId": "…", "decision": "approved", "artifactState": "approved", "waiverUsed": false, "findings": [ … ] }
```

**Approve** transitions the artifact `reviewing → approved` and hands it to
countersign + the release document (next issue, #10). **Reject** transitions it
`reviewing → rejected`. The transition uses the guarded
`ArtifactStore.transition`, and the verdict write is single-shot (guarded on the
case still being undecided), so two reviewers racing the same case cannot both
decide it — the second attempt gets `409 already_decided` (or `409 not_in_review`
once the artifact has left `reviewing`).

Every verdict emits a `review.approved` / `review.rejected` **audit event**
(actor = the reviewer's identity, subject = the artifact id), SPEC §10 / FR-12.

## reviewer ≠ author

A publisher cannot review their own artifact: the verdict author's OIDC identity
is compared to the artifact publisher's identity (the authorship anchor, SPEC §2),
and a match is refused with `403 self_review_forbidden`.

### The disclosed flagship waiver (SPEC §4a)

The single exception is the **flagship launch-phase waiver**. While the flagship
opens invite-only with a single-person review roster (GW-D18), the
separation-of-duties rule is *waived for operator-published widgets* until the
roster reaches ≥ 2 reviewers. It is controlled by
[`REVIEW_SELF_REVIEW_WAIVER`](#reviewer-set):

- **Off by default, and never enabled on a self-host instance** — every
  self-hoster keeps reviewer≠author.
- When **on**, an operator who is both the author and a configured reviewer may
  self-approve. The fact is recorded on the review case (`waiverUsed = true`) and
  emitted as its **own** audit event (`review.waiver`), distinct from the verdict
  event, so the countersign / transparency step (#10) can flag the affected
  release in its transparency-log entry (SPEC §4a). The verdict response echoes
  `waiverUsed: true`.
- With the waiver **off**, a self-review is refused even for a configured
  reviewer — the reviewer-set membership does not override the identity check.

## Reviewer set

There is no reviewer console this phase (SCOPE cut), so the reviewer roster and
the waiver are **configuration**, read once at boot (see
[`../config.md`](../config.md)):

| Variable | Meaning |
|---|---|
| `REVIEW_REVIEWER_IDENTITIES` | Comma-separated list of the OIDC identities permitted to submit a verdict, each in the canonical composite form `<url-encoded-issuer> <url-encoded-subject>` (the same string the audit log and publisher records key on). Empty means no identity can review (fail closed). |
| `REVIEW_SELF_REVIEW_WAIVER` | The disclosed flagship self-review waiver (SPEC §4a). `false` by default; a self-host instance must leave it off. |

The composite form is what `composeOidcIdentity(issuer, subject)` produces: each
part is percent-encoded and the two are joined with a single space. For an issuer
`https://issuer.example` and subject `reviewer-1`, the entry is
`https%3A%2F%2Fissuer.example reviewer-1`. Percent-encoding leaves no literal
comma in an entry, so the comma-separated list is unambiguous.
