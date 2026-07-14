# Operator policy page

Every Gridmason Registry instance publishes a **policy page**: the human-readable
statement of how that operator reviews, signs, and serves widget/plugin remotes.
The review *mechanism* is part of the platform and identical everywhere; the
*policy* belongs to each operator and is published here — there are no secret
rules (SPEC §4). This directory is the in-repo template for that page. There is no
publisher console this phase; the page is a static template an operator renders
and publishes (build spec, *Screens & UX*).

## Layout

```
docs/policy/
  README.md                     this file
  policy-page.template.html     SINGLE SOURCE — the template both variants render from
  variants/
    flagship.json               data for the flagship invite-only launch instance
    self-host.json              neutral defaults for a self-hosted instance
  rendered/
    flagship.html               GENERATED — do not hand-edit
    self-host.html              GENERATED — do not hand-edit
```

Both variants render from the **one** `policy-page.template.html`; only the data
file differs. That is what "same format, different policy" means in SPEC §4a.

## Rendering

```bash
npm run policy:render                       # regenerate both rendered/*.html
npm run policy:render -- --variant flagship --stdout   # print one to stdout
npm run policy:check                        # fail if committed pages are stale
```

`policy:check` (and the `test/policy.test.ts` suite) fail if the committed
`rendered/*.html` no longer match what the template + data produce, so a stale
page cannot merge. Rendering is deterministic — no timestamps or environment
input — so the same source always produces byte-identical output. The renderer is
a small dependency-free helper in [`scripts/render-policy.ts`](../../scripts/render-policy.ts);
it is a docs/ops tool and is **not** part of the running service or the container
image.

## The two variants (they must differ exactly on the SPEC §4a points)

**`flagship`** — the invite-only launch instance at `registry.gridmason.dev`.
It **discloses**, rather than hides (GW-D18, SPEC §4a):

- the **single-roster separation-of-duties waiver**: while the review roster is
  below two people, the operator's own published widgets are reviewed without a
  separate reviewer, and **every affected release is flagged in its
  transparency-log entry**;
- that the review **SLAs are published targets, not guarantees**, until review is
  staffed, alongside the current measured latency;
- the **countersign-key custody** note: an offline key held distinct from the
  reviewer's publishing identity, even while one person holds both roles.

**`self-host`** — the neutral default every self-hosted instance starts from. It
**carries none of the flagship's waiver language**. Separation of duties is
enforced (reviewer ≠ author), SLAs are operator-defined, and the operator fills in
its own roster, contacts, and policy. Self-hosters inherit none of the flagship's
launch-phase waivers (SPEC §4a) — the page states this explicitly.

## Customizing for your instance

Self-hosters: copy `variants/self-host.json`, fill in every field marked
`operator: …` (instance name, operator, review roster, SLAs, contacts,
countersign-key custody), then run `npm run policy:render -- --variant self-host`
and publish the rendered HTML. Keep the format so your users read the same page
everywhere. Do **not** copy the flagship's waiver language — those disclosures
apply only to an instance that is actually running single-rostered and has stated
so; enforce separation of duties instead.
