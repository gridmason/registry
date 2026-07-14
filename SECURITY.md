# Security Policy

Gridmason Registry is **supply chain**: it reviews, signs, and serves the code
that downstream hosts load at runtime. The platform's central claim — *"the
reviewed hash is the runnable artifact"* — only holds if this service computes
content hashes, applies the registry countersignature only after review, records
every release in the transparency log, and serves exactly the reviewed bytes. A
defect here can put malicious or tampered code in front of every host that trusts
the instance. We treat vulnerability reports accordingly.

## Reporting a Vulnerability

**Do not open a public issue, discussion, or pull request for a suspected
vulnerability.** Public disclosure before a fix is available puts every host that
trusts an affected registry — and its users — at risk.

Instead, report privately through GitHub's coordinated disclosure workflow:

1. Go to the **[Security Advisories](https://github.com/gridmason/registry/security/advisories/new)**
   page for this repository (Security tab → Report a vulnerability).
2. Provide as much of the following as you can:
   - Affected version(s) or commit(s), and the affected surface (e.g. publish
     pipeline, review/countersign, resolution API, revocation feed, CDN origin,
     self-host packaging).
   - A description of the issue and its security impact (e.g. a tampered artifact
     that would be served as approved, a countersignature applied without review,
     a revocation/kill that a host could bypass, a publisher-prefix takeover, an
     auth or access-control gap in an operator/ops API).
   - A minimal reproduction — ideally a script or request sequence against a
     local instance.
   - Any known workarounds.

If you cannot use GitHub Security Advisories, contact an administrator of the
[`gridmason`](https://github.com/gridmason) GitHub organization directly to
arrange a private channel.

## What to Expect

- **Acknowledgement** within **3 business days** of your report.
- An initial **assessment and severity triage** within **10 business days**.
- Ongoing updates through the advisory thread as we investigate and prepare a
  fix.
- **Coordinated disclosure**: we will agree on a disclosure timeline with you.
  Our target is a fix and published advisory within **90 days** of triage;
  actively-exploited issues are handled faster. We will credit you in the
  advisory unless you ask us not to.

We do not currently operate a paid bug-bounty program.

> **Note on the flagship instance.** A vulnerability report about the software in
> this repository is handled here. If you have found abuse of, or a live incident
> on, the hosted flagship at `registry.gridmason.dev` specifically, say so in the
> advisory so we can treat it operationally as well.

## Supported Versions

Gridmason is pre-1.0. Security fixes land on the latest `0.x` line and are
released as a new patch version; there is no long-term support for older `0.x`
releases. Always run the most recent published version.

| Version | Supported |
| ------- | --------- |
| latest `0.x` | :white_check_mark: |
| older `0.x` | :x: |

Once a `1.0` line ships, this table will be updated with a supported-version
window.

## Scope

In scope — anything that lets the registry serve code it should not, or lets a
host be deceived about what was served:

- **Served-artifact integrity**: a tampered or unreviewed artifact that would be
  served as approved; content-hash / immutability bypass; a publisher swapping
  code after review.
- **Signing & review integrity**: the registry countersignature being applied
  without a passing review, key-custody weaknesses, or a separation-of-duties
  bypass (reviewer = author) that is not the disclosed §4a launch-phase waiver.
- **Transparency, revocation & kill**: a release that can avoid a
  transparency-log entry; a revoked/killed remote that a conforming host could
  still load within its freshness rules; revocation-feed forgery or signature
  bypass.
- **Identity & namespace**: publisher-prefix takeover, OIDC-issuer confusion, or
  cross-registry prefix collision that misattributes an artifact.
- **Service auth & access control**: authentication/authorization gaps in the
  publisher, ops, or deployment APIs; injection or SSRF on the ingest path;
  privilege escalation into countersigning or kill-switch control.
- **Self-host supply chain**: build/publish provenance of the container image and
  the integrity of dependency pinning on the trust path.

Out of scope:

- Vulnerabilities in `@gridmason/protocol`'s verification library or wire
  formats — report those to
  [`gridmason/protocol`](https://github.com/gridmason/protocol), unless the root
  cause is how this service uses them.
- Findings in another Gridmason repo (`core`, `cli`, `dashboard`) — report those
  to their own repositories.
- Misconfiguration of a **self-hosted** instance by its operator (weak trust
  roots, disabled checks, a leaked countersign key) — that is an operator
  responsibility, not a defect in this software, unless the software makes the
  insecure configuration the default or hard to avoid.
- Reports generated solely by automated scanners without a demonstrated,
  reproducible security impact.

## Disclosure Philosophy

A registry is a high-value target precisely because hosts trust what it serves.
If you have found a way to make this service vouch for code it should have
rejected — or to strip a host of a revocation it should have honored — we want to
hear from you before anyone else does.
