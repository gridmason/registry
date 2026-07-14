# Contributing to Gridmason Registry

Thanks for your interest in contributing. This repository is the **self-hostable
federated widget/plugin registry** for Gridmason: the supply chain that serves
signed, content-hashed ES-module remotes to every host that trusts it. The
project runs the public flagship instance at `registry.gridmason.dev`, and any
organization can run its own. Because a registry decides what code downstream
hosts will load, contributions are held to a high bar for **security** and
**correctness**.

Please also read our [Code of Conduct](./CODE_OF_CONDUCT.md) and
[Security Policy](./SECURITY.md). Never file a suspected vulnerability as a
public issue or PR — follow [SECURITY.md](./SECURITY.md) instead.

## Contributor License Agreement (required)

Gridmason is released under [AGPL-3.0](./LICENSE), and Sniper7Kills LLC offers it
under separate commercial terms as well. To keep dual licensing possible, **every
contributor must sign the [Contributor License Agreement](./.github/CLA.md)**
before their pull request can be merged.

You do not need to do anything up front. When you open your first pull request, a
bot comments with the CLA text and a one-line instruction; you sign by replying
with the exact sentence it gives you. The signature is recorded once and applies
to all your future contributions. The CLA check is a required status —
**PRs from unsigned contributors are blocked from merging until the CLA is
signed** (see [`.github/workflows/cla.yml`](./.github/workflows/cla.yml)).

## Development setup

Requirements: **Node.js >= 20** (developed on Node 22+) and npm.

```bash
git clone https://github.com/gridmason/registry.git
cd registry
npm ci          # install exact, locked dependencies
```

Local checks — these are exactly what CI runs, and all four must be green before
you open a PR:

```bash
npm run build        # tsc -> dist/
npm test             # vitest run
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
```

Run the service locally and exercise the container the same way CI does:

```bash
npm run dev                                   # reload via tsx watch
docker build -t gridmason-registry . && \
  docker run --rm -p 8080:8080 gridmason-registry   # then curl /healthz
```

## Design principles this repo holds to

These are not style preferences — they are the guarantees the registry exists to
provide. A change that breaks one of them will not be merged.

- **A registry is supply chain, never a control plane** (SPEC §1). Hosts reach it
  over outbound 443 (or signed offline bundles) and must keep working when it is
  unreachable. Do not add a runtime dependency that a host cannot degrade past.
- **The reviewed hash is the runnable artifact.** Bundles are immutable and
  content-hashed; the served bytes are exactly what was reviewed and signed. No
  code path may let a publisher swap content after review.
- **Formats live in `@gridmason/protocol`, not here.** The manifest, signature
  envelope, transparency-log entry, revocation feed, trust-root, and bundle
  formats are contracts owned by `protocol`. Do not fork or redefine them in this
  repo — if you need a format change, open an issue in
  [`gridmason/protocol`](https://github.com/gridmason/protocol) and consume the
  new version.
- **Automated review checks are imported from the shared `gridmason/cli` checks
  module, never reimplemented** (SPEC §4, FR-3). The whole point is that
  `gridmason lint` on a developer's machine and the registry's server-side
  automated review run the *same code* and produce identical verdicts.
- **The review mechanism is platform; the policy is the operator's, and it is
  published** (SPEC §4). There are no secret rules. Anything that changes what a
  reviewer accepts must be visible in the operator's policy page.
- **Self-hosters inherit none of the flagship's launch-phase waivers** (SPEC
  §4a). The flagship's single-roster separation-of-duties waiver and
  published-target SLAs are specific to `registry.gridmason.dev`. The `self-host`
  policy variant must never carry that waiver language, and defaults must be safe
  (separation of duties enforced). See the policy template below.

## The operator policy page

The registry ships a single policy-page template that renders one deterministic
HTML page per operator variant. The source of truth is
[`docs/policy/policy-page.template.html`](./docs/policy/policy-page.template.html)
plus the per-variant data in
[`docs/policy/variants/`](./docs/policy/variants/); the committed HTML in
`docs/policy/rendered/` is **generated — never hand-edit it**.

```bash
npm run policy:render    # regenerate docs/policy/rendered/{flagship,self-host}.html
npm run policy:check     # fail if the committed pages have drifted from the source
```

If you change the template or a variant's data, run `npm run policy:render` and
commit the regenerated pages in the same PR. The test suite and `policy:check`
both fail on drift, so a stale rendered page cannot merge. See
[`docs/policy/README.md`](./docs/policy/README.md) for the two variants and their
required differences.

## Pull request checklist

Before you open a PR:

- [ ] `npm run build && npm test && npm run lint && npm run typecheck` all pass.
- [ ] Tests added/updated for behavior you changed — including negative cases for
      anything on the trust/verification path.
- [ ] If you touched the policy template or variant data, `npm run policy:check`
      passes and the regenerated pages are committed.
- [ ] No format was redefined locally instead of consumed from
      `@gridmason/protocol`; no automated check was reimplemented instead of
      imported from the `gridmason/cli` checks module.
- [ ] The CLA is signed (the bot will guide you on your first PR).
- [ ] The PR description explains the security/supply-chain impact, if any.

Small, focused PRs review faster. For a significant change — especially anything
touching the trust model, review pipeline, or the served-artifact path — opening
an issue to discuss the approach first is welcome.

## Reporting bugs and requesting features

Use the [issue templates](./.github/ISSUE_TEMPLATE/). **Do not** report a
suspected vulnerability as a normal issue — follow [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [AGPL-3.0](./LICENSE) license and are covered by the terms of the
[CLA](./.github/CLA.md) you signed.
