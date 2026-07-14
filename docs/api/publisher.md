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

> **Signature verification is deferred this phase (GW-D19 SCOPE cut).** The
> registry validates the token's claims and enforces the issuer allowlist, but
> does not yet cryptographically verify the token signature against the issuer's
> JWKS. Full keyless verification lands with the signing/countersign work and the
> `@gridmason/protocol` verify lib. Do not treat a registration as
> cryptographically attested until then.

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
| `401` | `invalid_token` | token malformed or missing `iss`/`sub` |
| `401` | `token_expired` | token `exp` is in the past |
| `403` | `issuer_not_allowed` | token issuer not on the allowlist |
| `409` | `prefix_taken` | prefix already claimed on this registry |
| `409` | `publisher_exists` | this identity already has a publisher record |

Emits two `AuditEvent`s (FR-12): `publisher.register` (subject = publisher id)
and `prefix.claim` (subject = `<registryId>/<prefix>`), actor = `<issuer> <subject>`.

### `GET /v1/publishers/:id` — read a publisher record

Anonymous. `200` with the record, or `404 not_found`.

### `GET /v1/prefixes/:prefix` — read prefix ownership

Anonymous. `200` with source-qualified ownership, or `404 not_found`:

```jsonc
{
  "prefix": "acme",
  "registryId": "registry.local",
  "owner": { "publisherId": "…", "issuer": "https://…", "subject": "…", "tier": "community" }
}
```

## Error body

Every non-2xx response carries a uniform body:

```jsonc
{ "error": { "code": "prefix_taken", "message": "…" } }
```
