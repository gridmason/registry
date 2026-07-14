# Resolution API

The distribution surface host shells call to load widgets (FR-7, FR-10; SPEC §8,
§9; GW-D22). It turns a **gate snapshot** — the set of remotes a host has enabled —
into an **import-map fragment** the shell merges into its native-ESM import map:
each enabled module resolves to a **hash-pinned** entry URL on the serving origin
(#12) plus the **signature bundle** the host verifies with `@gridmason/protocol`
before it loads a byte, plus `scopes` entries that resolve shared-dependency majors.

It does **not** serve the bytes (that is the serving surface, #12) and does **not**
decide enablement (that is the host's own gate service) — it maps an already-decided
gate snapshot to verifiable URLs.

## Wire contract lives in `@gridmason/protocol`

The gate-snapshot request and import-map-fragment response shapes are defined by
`@gridmason/protocol` (`types/resolution`, package ≥ 0.3.0): `GateSnapshot`,
`GateModule`, `SharedOffer`, `ImportMapFragment`, `ResolvedModule`,
`SignatureBundle`, `ExcludedModule`, and `ExclusionReason`. The registry authored
these shapes and owned them alone until the Gridmason Dashboard's Phase-B remote
loader joined as a second consumer, at which point they were **promoted** into the
shared package (protocol #66) with generated JSON schemas and ajv vectors. The
registry now re-exports them from `@gridmason/protocol` (`src/resolution/types.ts`)
rather than owning them; hosts pin the same contract instead of copying it.

Every `POST /v1/resolve` response validates against the published schema
`@gridmason/protocol/schemas/import-map-fragment.json` (asserted in
`test/resolution/api.int.test.ts`); the request body has a companion
`gate-snapshot.json` schema.

## Anonymous, never a control plane

`POST /v1/resolve` takes **no authentication** and requires **no deployment
registration**. A registry is supply chain, never a control plane a deployment must
phone (SPEC §1, §8): the Deployment API (canary/rollback/targeted kill) is opt-in
and a Phase-C cut, and resolution works without it. The gate snapshot is the
*host's* enablement state; the registry only qualifies it with verifiable URLs.

## Source-qualified identity (SPEC §9, FR-10)

Publisher prefixes are unique **only within a registry** — there is no global prefix
authority. Every output is therefore qualified by this registry's id:

- the fragment carries `registry` (this instance's `REGISTRY_ID`);
- each module carries `source` (the same id), `publisher`, `tag`, and `version`;
- each module is mapped under the bare specifier `"<registry>/<tag>"`.

A host trusting several registries pins each prefix to one registry and composes
absolute URLs by prepending that registry's **pinned serving origin** to the
root-relative paths this API returns (`/v1/artifacts/:hash`). A merged map in which
two registries claim the same prefix is the host's configuration error to reject.

## Only published, countersigned, non-revoked releases resolve

A module resolves only when it passes **both** gates (`state ∧ feed`, SPEC §6):

1. **Lifecycle state** — its `(publisher, tag, version)` names an artifact currently
   in the **`approved`** state *and* backed by a **countersigned release document**
   (the same release #12 serves). Any other state — `revoked`, `killed`, `submitted`,
   `reviewing`, `rejected` — excludes it.
2. **Signed revocation/kill feed** (#14) — the resolver cross-checks the artifact
   against the registry's signed feed through its `RevocationCheck` seam. A release
   the feed lists as revoked/killed is excluded **even if** its lifecycle state has
   not yet been observed as changed — closing the window between a distribution-state
   write and its feed publication.

So **a revoked or killed remote never enters a fragment**: an operator revoke/kill
both transitions the artifact out of `approved` and appends a feed entry, and either
gate alone is sufficient to exclude it.

Unresolvable modules are **reported** in the `excluded` array (so the host can
render its SPEC §6/§8 fallback card) but are **never** placed in `imports`.

## Hash-pinned URLs + signature bundle

Each resolved module's `url` is the hash-pinned serving path of its **entry**
module (`/v1/artifacts/<entry-hash>`), derived from the countersigned release's
`{ path → hash }` map. Its `bundle` is exactly the material `verifyRelease`
consumes as its untrusted, network-delivered inputs — identical to the serving
surface's `GET /v1/releases/:hash` body:

- `release` — the signed release document (`{ path → hash }`);
- `envelope` — the completed dual-signature envelope (publisher + registry
  countersignature);
- `logEntry` — the transparency-log inclusion entry.

The host supplies the pinned trust roots, CA/countersign roots, log key, and clock
out of band; nothing in the fragment is trusted for being in the fragment.

## Shared-dependency scopes (GW-D22)

Loading is native ESM + import maps — **no Module-Federation runtime**. A widget's
manifest `sharedScope` declares the bare-specifier **ranges** it expects the host to
satisfy (e.g. `{ "react": "^17.0.0" }`). The **host shell declares what it offers**
per specifier (one URL per major it provides) in the request's `shared` field.

For each widget, resolution picks the **highest offered major** whose number the
range permits, then emits a `scopes` entry — keyed by the widget's entry URL — only
when that major differs from the shell's **default** (the highest offered major
overall). Widgets that agree on the default share one instance and produce no scope
(**never a global override**). A widget whose range no offer satisfies is excluded
(`unsatisfied_shared_scope`).

> Range support is the framework-default forms a `sharedScope` uses: caret, tilde,
> exact, x-range, lower bound, and `||` unions. Full SemVer range algebra (hyphen
> ranges, arbitrary comparator sets) is a documented follow-up; the offer's explicit
> `major` keeps the matched surface small.

## Endpoint

### `POST /v1/resolve` — resolve a gate snapshot

No authentication. Request body (JSON):

```jsonc
{
  "registry": "registry.gridmason.dev",   // must equal this instance's REGISTRY_ID
  "modules": [                              // the enabled remotes to resolve (exact versions)
    { "publisher": "acme", "tag": "acme-chart", "version": "2.3.1" }
  ],
  "shared": {                               // optional: what the shell offers per shared specifier
    "react": [
      { "major": 18, "url": "/vendor/react@18.js" },
      { "major": 17, "url": "/vendor/react@17.js" }
    ]
  }
}
```

`200 OK` — the import-map fragment:

```jsonc
{
  "registry": "registry.gridmason.dev",
  "imports": {
    "registry.gridmason.dev/acme-chart": "/v1/artifacts/sha2-256:<entry-hash>"
  },
  "scopes": {
    // emitted only for a widget needing a non-default shared major
    "/v1/artifacts/sha2-256:<entry-hash>": { "react": "/vendor/react@17.js" }
  },
  "modules": [
    {
      "source": "registry.gridmason.dev",
      "publisher": "acme",
      "tag": "acme-chart",
      "version": "2.3.1",
      "specifier": "registry.gridmason.dev/acme-chart",
      "url": "/v1/artifacts/sha2-256:<entry-hash>",
      "bundle": { "release": { }, "envelope": { }, "logEntry": { } }
    }
  ],
  "excluded": []   // requested modules that did not resolve, each with a `reason`
}
```

A requested module that does not resolve appears in `excluded`, never in `imports`:

```jsonc
{ "publisher": "acme", "tag": "acme-chart", "version": "9.9.9", "reason": "unknown_module" }
```

### Exclusion reasons

| `reason` | Meaning |
|---|---|
| `unknown_publisher` | No publisher owns that prefix on this registry. |
| `unknown_module` | No `(publisher, tag, version)` artifact exists. |
| `not_distributable` | The artifact is not `approved` (revoked, killed, or never approved), or the signed feed lists it as revoked/killed. |
| `no_release` | The artifact has no countersigned release document. |
| `unresolvable_release` | The release or its manifest is internally inconsistent. |
| `unsatisfied_shared_scope` | No shell offer satisfies a widget's `sharedScope` range. |

### Errors

Every non-2xx carries `{ "error": { "code", "message" } }`.

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_request` | The body is not a well-formed gate snapshot. |
| `400` | `wrong_registry` | `registry` does not equal this instance's id. |

An empty `modules` array is valid and returns an empty fragment (a host with
nothing enabled).

## Caching

The fragment is derived from immutable, content-addressed releases, but the *set* a
snapshot maps to changes as distribution state flips (a kill), so the response is
**not** marked immutable. A host re-resolves within the §6 revocation TTL; the
hash-pinned URLs it hands back to the browser are the immutable, CDN-cacheable ones
(#12).
