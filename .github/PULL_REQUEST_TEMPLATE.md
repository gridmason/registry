<!--
  Thanks for contributing to Gridmason Registry. Keep PRs small and focused.
  First-time contributors: the CLA Assistant bot will comment with a one-line
  instruction to sign — your PR cannot merge until the CLA is signed.
-->

## What & why

<!-- What does this change, and what problem does it solve? Link the issue. -->

Closes #

## Supply-chain / security impact

<!--
  A registry decides what code hosts load. State the impact, or "none".
  Flag anything touching: the served-artifact path, hashing/immutability,
  review/countersign, the transparency log, revocation/kill, identity/prefixes,
  or an operator/ops API.
-->

## Checklist

- [ ] `npm run build && npm test && npm run lint && npm run typecheck` all pass locally.
- [ ] Tests added/updated, including negative cases for anything on the trust path.
- [ ] If I changed the policy template or variant data, `npm run policy:check` passes and the regenerated `docs/policy/rendered/*.html` are committed.
- [ ] I did not redefine a wire format locally (formats live in `@gridmason/protocol`) or reimplement an automated check (imported from the `gridmason/cli` checks module).
- [ ] The `self-host` policy variant carries none of the flagship's launch-phase waiver language.
- [ ] I have signed the CLA (the bot guides first-time contributors).
