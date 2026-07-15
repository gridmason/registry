# Automated review stage

The automated-review stage runs immediately after a successful upload intake
(the publish flow, [`docs/api/publish.md`](../api/publish.md)) and gates every
artifact before the human review lane. It satisfies **FR-3** and SPEC §4, §7,
§9.

## Shared checks — imported, never reimplemented

The stage runs the **shared checks module** verbatim:

- **Module:** `@gridmason/cli/checks` (the `./checks` export of `@gridmason/cli`).
- **Version pin:** `@gridmason/cli` `^0.6.0` (see `package.json`); the resolved
  version is recorded on every report as `checksReport.checksVersion` and mirrored
  by the `CHECKS_VERSION` constant in [`src/review/report.ts`](../../src/review/report.ts).

Importing this module — rather than reimplementing any check — is the central
constraint of FR-3 / SPEC §9: `gridmason lint` and the registry's automated
review run the **identical** code path, so a locally-green artifact passes review
by construction (there is no second implementation to diverge). The registry
contributes only the glue that builds the check context from an uploaded artifact
and persists the result; it declares no check logic of its own. The
`test/auto-review/parity.test.ts` suite asserts the stage reproduces
`runChecks(...)` byte-for-byte on a shared fixture set.

The checks that run (all from the shared module, in report order):

| Check id | What it enforces |
|---|---|
| `manifest.schema` | the manifest is valid against the `@gridmason/protocol` manifest JSON Schema |
| `manifest.tag` | the tag is lowercase, hyphenated, and **publisher-prefixed** (SPEC §5) |
| `manifest.capabilities` | each capability's scope grammar is well-formed |
| `sdk.*` | SDK-adherence static analysis over the served source (raw network, token reach, obfuscation) |
| `deps.acyclic` | the `requires` graph is acyclic — a **circular `requires` is rejected** (SPEC §7) |
| `dom.abuse` | DOM-abuse heuristics over the served source |

The stage runs the module's current, offline surface only. Registry-aware checks
(capability diff, transitive cross-manifest DAG resolution) are later phases and
are deliberately **not** enabled here (`CheckContext.registry` is left unset).

## Context built from the uploaded artifact

The check context is built from the parsed upload parts, exactly as
`gridmason lint` builds it from disk:

- **`manifest`** — the `manifest` part parsed as JSON. A part that is not valid
  JSON (or absent) is a hard load failure (`checksReport.error`), and the artifact
  is rejected.
- **`sourceFiles`** — the served `entry` + `chunk` parts whose path has a source
  extension (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`), the registry's
  analogue of the on-disk source the CLI walks.

## Outcome — report, transition, audit

For each reviewed artifact the stage:

1. **Persists the report** as `ReviewCase.checks_report` (jsonb, migration 0001)
   via the review-case store. The report is
   `{ checksModule, checksVersion, status, results, error? }`, where `results` is
   the verbatim shared-checks output.
2. **Transitions the artifact** from `submitted`:
   - clean run → `reviewing` (handed to the human review lane, next issue);
   - any check failed, or a manifest load failure → `rejected`.
3. **Emits an `AuditEvent`** for the transition (`review.reviewing` /
   `review.rejected`, actor `system`, subject the artifact id) — SPEC §10, FR-12.

The stage is deterministic: the same artifact bytes always produce the same
report and the same transition.

## Wiring

`buildServer` mounts the stage alongside the publish route whenever a review-case
store is available. The real service always has one (Postgres, backed by
`storage`), so every accepted upload is reviewed before the response. See
[`src/review/automated.ts`](../../src/review/automated.ts),
[`src/review/report.ts`](../../src/review/report.ts), and
[`src/review/store.ts`](../../src/review/store.ts).
