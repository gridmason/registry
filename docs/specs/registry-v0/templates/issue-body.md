# Issue-body template (for spec-to-issues)

Every sub-issue created from this spec package MUST be self-sufficient for an autonomous
AI worker that has this repo checked out and NO other context. Include all sections:

```markdown
## Context
- **Epic:** <epic id + title> (<phase A|B>)
- **Spec:** docs/specs/<slug>/spec.md — this issue satisfies: <FR-n list>
- **FR text (quoted verbatim):**
  > <paste the full FR statements — do not just cite numbers>
- **Engineering spec sections:** docs/SPEC.md §<n> — <one-line summary of what each section mandates>

## Task
<2–4 paragraphs: exactly what to build, where it lives in the repo layout, and how it
connects to neighbors. Name modules/files/types explicitly. State what already exists
vs what this issue creates.>

## Constraints (project decisions that bind this work)
- Loading = native ESM + import maps; no Module-Federation runtime (GW-D22)
- TS is the schema-authoring surface; JSON Schemas are generated (protocol FR-5)
- <any other GW-D decisions or SCOPE cuts this issue must respect — quote them>

## Acceptance criteria
- [ ] <verifiable statement — a reviewer or CI can check it mechanically>
- [ ] <tests: name the test files/suites expected>
- [ ] <docs: what must be documented and where>

## Dependencies
- Blocked by: <sub-issue title in this epic | cross-repo: gridmason/<repo> milestone <M-x> | none>
- Cross-repo contract needs → file an issue on that gridmason repo and link it here.
  NEVER open issues/comments outside gridmason-org repos.

## Hints
- Files/areas: <paths>
- Libraries: <pinned choices, or "decide + pin in this issue, document rationale">
- Reference: <links to docs/SPEC.md anchors, protocol vectors, sibling-repo GitHub URLs>
```

Rules for the issue creator:
1. Quote, don't cite — FR text and relevant SPEC.md sentences go IN the body.
2. Acceptance criteria must be executable/observable (a command, a test name, a behavior).
3. If the sub-issue in spec.md is too thin to fill this template, expand it from
   docs/SPEC.md while creating the issue — never create a one-liner issue.
