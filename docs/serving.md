# Hash-addressed serving

The registry's read origin (FR-6; SPEC §3, §10). After a release is countersigned
(`docs/countersign.md`), its files are served by **content hash** with immutable
cache headers, so a CDN caches them indefinitely and the registry API stays off a
page load's critical path. This is the byte origin the resolution API's import
maps (#13) point at; it resolves no import maps itself.

## Origin contract

Two anonymous, read-only `GET` surfaces (`src/http/serving.ts`), both
content-addressed and immutably cacheable:

| Route | Serves |
|---|---|
| `GET /v1/artifacts/:hash` | the exact immutable bytes of one artifact file, from the object-store origin, addressed by its content hash (`sha2-256:<hex>`) |
| `GET /v1/releases/:hash`  | the countersigned release document a host caches and verifies offline, addressed by the release hash its publisher signed (`subject.releaseHash`) |

`GET /v1/releases/:hash` returns `{ releaseDoc, envelope, logEntry }`: the
`{ path → hash }` map (SPEC §3), the completed dual-signature envelope (publisher +
registry countersignature), and the transparency-log inclusion entry — everything
a host needs to verify the chain offline (SPEC §10). Its `releaseDoc` canonicalizes
(JCS / RFC-8785) back to the release hash it is served at.

## What is servable

A content hash is served **only when a countersigned release document lists it**
(`ReleaseDocStore.findServedPathForHash`). The signed release is the authority for
what the runtime may load, so:

- an **unknown hash** refuses with `404 unknown_hash`;
- the **source archive** — content-addressed in the object store at intake, but
  listed by no release document — is **not servable** (it is review input, not a
  served remote), and refuses with `404` even though its blob is present;
- a hash a release lists but whose blob is absent from the store is an origin
  fault, logged and answered `404 blob_missing`.

Nothing that is not blessed by a signed release ever leaves this surface.

## Cache headers

Every served, hash-addressed response carries:

```
Cache-Control: public, max-age=31536000, immutable
ETag: "<content-hash>"
Content-Type: <inferred from the served path's extension>
```

The bytes behind a hash never change, so `immutable` tells caches never to
revalidate; `public` permits shared CDN caching. The content hash is a strong
validator (identical bytes ⇒ identical `ETag`), so a caller presenting a matching
`If-None-Match` gets a `304`. Content types are inferred from the served path
recorded in the release document (`src/serving/content-type.ts`): ES-module
remotes serve as `text/javascript` (native ESM loading, GW-D22, refuses anything
else); an unrecognized extension falls back to the non-executable
`application/octet-stream`.

## CORS

Both serving surfaces are **anonymous**, so a browser-based host — the Gridmason
Dashboard on `localhost:5173` fetching from a registry on `localhost:8080`, or any
embedding app — must be able to read them cross-origin. They send **wildcard CORS**:

```
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: etag, x-request-id
```

and answer a preflight `OPTIONS` with `204` +
`Access-Control-Allow-Methods: GET, OPTIONS`,
`Access-Control-Allow-Headers: content-type`, and a 10-minute
`Access-Control-Max-Age`. A wildcard is the right posture across the anonymous
public surfaces (this origin, `POST /v1/resolve`, `GET /v1/revocation/feed`, and the
anonymous publisher/prefix reads): they take **no credentials** — so no
`Access-Control-Allow-Credentials` — and the bytes are **hash-addressed** (or, for a
release document, **registry-signed**), a host verifies them with
`@gridmason/protocol` before trusting, and the `ETag` a host reads for caching is
the content hash it was going to verify anyway. The requesting origin is not a trust
boundary here.

`Access-Control-Expose-Headers` lists `etag` (the content-hash validator) and the
correlation-id header; the other headers above are CORS-safelisted response headers
a host reads without them being listed. The **authenticated** control plane
(publisher registration, review lane, ops revoke/kill, publisher-facing
status/appeal) deliberately sends **no** CORS — a cross-origin browser preflight for
its `Authorization` header finds no matching response and is blocked, keeping the
control plane non-browser-callable. The wiring + route allowlist is
[`src/http/cors.ts`](../src/http/cors.ts).

## Immutability and the hot path

The surface exposes **no mutation**. There is no route that overwrites or deletes
a published hash (SPEC §3 — the reviewed hash is the runnable artifact), so a
mutating request to a served object is simply not routed (`404`). What is servable
changes only through the publish/review state transitions, which already emit
`AuditEvent`s; serving itself is **side-effect-free and emits no per-request audit
event** — it is the hot path, never the control plane (SPEC §8, §10).

Registry unavailability degrades to hosts' last-verified cached release documents
within the 24 h revocation TTL (SPEC §6, §10); revocation of an already-released
hash is a separate distribution-state overlay (#14), not part of this origin.
