# Publish API

The artifact upload API (FR-1; SPEC §2, §3, §8). It is the intake the `gridmason`
CLI calls: an authenticated publisher uploads a content-hashed, immutable artifact
and its publisher signature envelope, and the registry records a **submitted**
artifact for the review lane. It does **not** run checks or countersign — that is
the automated-review stage (#8) and countersign (#10).

## Identity + authorization

The upload presents a bearer token, verified exactly as publisher registration is
(OIDC discovery → JWKS signature check, allowlisted issuers, asymmetric algorithms
only, fail-closed) — see [`publisher.md`](./publisher.md) for the full model. Two
bindings gate an upload:

1. **Registered publisher.** The verified `(issuer, subject)` identity must own a
   publisher record (registered via the Publisher API). An unknown identity is
   refused `403 not_registered`.
2. **Tag under the publisher's prefix.** The artifact `tag` must fall under the
   publisher's registered namespace prefix (`<prefix>-…`, SPEC §5). A well-formed
   tag outside the prefix is refused `403 tag_not_in_prefix` — this is the
   identity↔namespace check that stops a publisher shipping under another's name.

## Immutability

A `(publisher, tag, version)` is published **once** and never overwritten (SPEC
§3): the reviewed hash is the runnable artifact, so a publisher cannot swap code
post-review. A re-upload of an existing version is refused `409 version_exists`.
This is enforced by a unique database constraint, not a read-then-write check, so
it holds under concurrency.

## Content addressing

Every served part is addressed by the multihash-tagged SHA-256 of its **exact
uploaded bytes** (`sha2-256:<hex>`), computed with `@gridmason/protocol`'s hashing
so the digests match the protocol's published vectors. The raw bytes are stored in
the object store keyed by that hash; the response returns the `{path → hash}` map.
The signed release document that pins this map for the runtime is emitted later at
countersign time — intake creates only the immutable blobs and the artifact record.

## Signature envelope

Every version carries a publisher signature envelope (keyless by default,
Sigstore-style, OIDC-bound — SPEC §2). **This phase validates the envelope
structurally only** — a DSSE-shaped object (`payloadType` + `payload` +
non-empty `signatures[]`) — and stores it opaquely with the artifact. A
missing/malformed envelope is refused `400 invalid_envelope`. Cryptographic
verification against the `@gridmason/protocol` envelope types is deferred to
countersign (#10), gated on protocol P-E3 publishing those types.

## Endpoint

### `POST /v1/artifacts` — upload an artifact

Requires `Authorization: Bearer <oidc-token>` from an allowlisted issuer.

Request body (JSON; each file part carries its exact bytes base64-encoded):

```jsonc
{
  "tag": "acme-clock",          // must fall under the publisher's prefix
  "version": "1.2.0",
  "files": [                    // exactly one manifest + one entry; unique paths
    { "path": "manifest.json",       "role": "manifest", "bytes": "<base64>" },
    { "path": "entry.js",            "role": "entry",    "bytes": "<base64>" },
    { "path": "chunks/a.js",         "role": "chunk",    "bytes": "<base64>" },
    { "path": "schemas/config.json", "role": "schema",   "bytes": "<base64>" },
    { "path": "README.md",           "role": "doc",      "bytes": "<base64>" }
  ],
  "sourceArchive": "<base64>",  // signed source archive (GW-D19 interim review input)
  "envelope": {                 // DSSE-shaped publisher signature envelope
    "payloadType": "application/vnd.gridmason.artifact+json",
    "payload": "<base64>",
    "signatures": [{ "sig": "<base64>", "keyid": "…" }]
  }
}
```

File `role` is one of `manifest | entry | chunk | schema | doc`. The transport is
JSON+base64 within the configured request-body limit
(`HTTP_BODY_LIMIT_BYTES`, see [`config.md`](../config.md)); a streaming multipart
transport for very large bundles is a later optimisation.

On success the response is the source-qualified artifact record:

```jsonc
{
  "id": "…",
  "registryId": "registry.local",
  "publisherId": "…",
  "tag": "acme-clock",
  "version": "1.2.0",
  "state": "submitted",
  "contentHashes": { "manifest.json": "sha2-256:…", "entry.js": "sha2-256:…" },
  "sourceArchiveRef": "sha2-256:…",
  "createdAt": "2026-07-14T00:00:00.000Z"
}
```

Responses:

| Status | Body `error.code` | When |
|---|---|---|
| `201` | — | accepted; body is the submitted artifact record above |
| `400` | `invalid_request` | body missing `tag`/`version`/`files`/`sourceArchive`, or wrong types |
| `400` | `invalid_artifact` | a file part is malformed (bad role, non-base64 bytes, duplicate path), or not exactly one manifest + one entry |
| `400` | `invalid_tag` | `tag` is structurally invalid (not a lowercase, hyphenated custom-element name) |
| `400` | `invalid_envelope` | the publisher signature envelope is missing or not DSSE-shaped |
| `401` | `missing_token` | no bearer token |
| `401` | `invalid_token` | token malformed, oversized, missing `iss`/`sub`, or signature does not verify |
| `401` | `token_expired` / `token_not_yet_valid` | token `exp`/`nbf` outside tolerance |
| `403` | `issuer_not_allowed` / `audience_not_allowed` | token issuer/audience rejected |
| `403` | `not_registered` | the verified identity owns no publisher record |
| `403` | `tag_not_in_prefix` | `tag` is well-formed but not under the publisher's prefix |
| `409` | `version_exists` | this `(publisher, tag, version)` is already published (immutable) |
| `503` | `verification_unavailable` | the issuer's discovery/JWKS endpoint could not be reached (retryable) |

## Audit

Every accepted upload emits `publish.submitted` (actor = `<issuer> <subject>`,
subject = artifact id). Denials emit `publish.denied` (FR-12): a token that fails
verification is audited with actor `anonymous` and subject `publish:<reason>`
(claims untrusted); an authenticated denial (`not-registered`,
`tag-not-in-prefix`, `duplicate-version`) is audited with the identity as actor.

## Error body

Every non-2xx response carries the uniform body
`{ "error": { "code": "…", "message": "…" } }`.
