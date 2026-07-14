# Publisher API

The publisher records + prefix-registration API (FR-2, FR-10; SPEC §2, §5, §9).
It is the identity/ownership foundation the publish and review lanes check
against; it does **not** upload artifacts (that is the Publish API).

There is no console this phase (SCOPE cut) — status is obtained over this API /
CLI polling.

## Identity model

A publisher is bound to an **OIDC identity**. Registration presents a bearer
token; the registry records the token's `iss` (issuer) and `sub` (subject)
claims. The **issuer is the trust anchor** (SPEC §2): each registry configures an
explicit issuer allowlist (`OIDC_ISSUER_ALLOWLIST`, see
[`config.md`](../config.md)) and refuses a token from any other issuer.

The token is **cryptographically verified**, not merely inspected. For the
token's `iss` — which must be on the allowlist (`OIDC_ISSUER_ALLOWLIST`) — the
registry runs OIDC discovery (`<issuer>/.well-known/openid-configuration`),
fetches the issuer's `jwks_uri` key set (cached, with automatic refetch on key
rotation), and verifies the signature before any claim is believed. The
allowlist is checked first, so the registry only ever contacts issuers it already
trusts. Verification:

- accepts **asymmetric algorithms only** — `alg: none` and the `HS*` family are
  refused, closing the alg-confusion bypass;
- enforces `exp` and `nbf` (with a small clock-skew tolerance);
- enforces `aud` when `OIDC_AUDIENCE` is configured;
- **fails closed**: if the issuer's discovery or JWKS endpoint is unreachable the
  request is rejected (`503`), never accepted unverified;
- **follows no redirects** on the discovery or JWKS fetch, so a compromised
  issuer cannot bounce the registry at an internal address;
- rejects a bearer token larger than **8 KiB** before decoding it, and throttles
  repeated verifications against an unreachable issuer so invalid-token spam
  cannot amplify into unbounded discovery/JWKS traffic.

## Namespace prefix

Each publisher owns one **namespace prefix** — the leading segment every widget
`tag` and package path it publishes must start with (`<prefix>-…`). A prefix is
lowercase, starts with a letter, is made of `[a-z0-9]` groups joined by single
hyphens, and is at most 63 characters.

Prefixes are unique **only within a registry** — there is no global authority
(SPEC §9). The same prefix may be claimed on a different registry; a host that
trusts several registries pins each prefix to one and resolves identity as the
source-qualified `(registry, publisher, tag)`. Because the shipped schema models
one prefix per publisher, **registration is the prefix claim** — the two happen
in one call.

## Record shape

Every output is source-qualified with `registryId`.

```jsonc
{
  "id": "…",                      // registry-local publisher id
  "registryId": "registry.local", // source qualifier (SPEC §9)
  "identity": { "issuer": "https://…", "subject": "…" },
  "prefix": "acme",
  "tier": "community",            // community | verified | operator
  "createdAt": "2026-07-14T00:00:00.000Z",
  "publishedVersions": [],        // read-through projection of Artifact (empty until the publish lane)
  "reviewHistory": []             // read-through projection of ReviewCase (empty until the review lane)
}
```

`tier` (SPEC §5: community → verified → operator) is a stored attribute this
phase — there is no domain-proof automation yet. The field is kept so the review
lane can later key its reviewer≠author + waiver logic on it.

## Endpoints

### `POST /v1/publishers` — register a publisher and claim its prefix

Requires `Authorization: Bearer <oidc-token>` from an allowlisted issuer.

Request body:

```jsonc
{ "prefix": "acme", "tier": "verified" }  // tier optional, defaults to "community"
```

Responses:

| Status | Body `error.code` | When |
|---|---|---|
| `201` | — | registered; body is the record above |
| `400` | `invalid_request` | body missing `prefix`, or an invalid `tier` |
| `400` | `invalid_prefix` | `prefix` fails the format rules |
| `401` | `missing_token` | no bearer token |
| `401` | `invalid_token` | token malformed, over the 8 KiB size cap, missing `iss`/`sub`, or its **signature does not verify** against the issuer JWKS (includes `alg: none`/`HS*`) |
| `401` | `token_expired` | token `exp` is in the past |
| `401` | `token_not_yet_valid` | token `nbf` is in the future |
| `403` | `issuer_not_allowed` | token issuer not on the allowlist |
| `403` | `audience_not_allowed` | token `aud` does not include the configured `OIDC_AUDIENCE` |
| `409` | `prefix_taken` | prefix already claimed on this registry |
| `409` | `publisher_exists` | this identity already has a publisher record |
| `503` | `verification_unavailable` | the issuer's discovery/JWKS endpoint could not be reached (fail closed — retryable) |

On success, emits two `AuditEvent`s (FR-12): `publisher.register` (subject =
publisher id) and `prefix.claim` (subject = `<registryId>/<prefix>`), actor =
`<issuer> <subject>`. A rejected token emits a `publisher.register.denied` event
(actor `anonymous`, subject `register:<reason>`) — the token failed verification,
so its claims are not trusted as an identity.

### `GET /v1/publishers/:id` — read a publisher record

Anonymous. `200` with the record, or `404 not_found`.

### `GET /v1/prefixes/:prefix` — read prefix ownership

Anonymous. `200` with source-qualified ownership, or `404 not_found`:

```jsonc
{
  "prefix": "acme",
  "registryId": "registry.local",
  "owner": { "publisherId": "…", "tier": "community" }
}
```

This unauthenticated lookup deliberately exposes **only** the registry-local
`publisherId` and `tier` — never the owner's raw OIDC `issuer`/`subject`. Those
claims are a fingerprinting surface with no bearing on "who owns this prefix
here"; read `GET /v1/publishers/:id` for the full record.

## Error body

Every non-2xx response carries a uniform body:

```jsonc
{ "error": { "code": "prefix_taken", "message": "…" } }
```
