# Widget catalog API

The anonymous list/search surface hosts use to show users what a registry offers
(#63; the Gridmason Dashboard's Add-Widget picker and the registry web UI both read
it). [Resolution](resolution.md) needs an exact `(publisher, tag, version)`; this is
the browse surface that finds them.

## `GET /v1/widgets` — list / search published widgets

Anonymous, and **wildcard-CORS'd** like the other public reads (see
[`../serving.md`](../serving.md#cors)) so a browser host can call it cross-origin.

Query parameters (all optional):

| Param | Meaning |
|---|---|
| `query` | Case-insensitive substring matched against a widget's **tag** and **name**. |
| `publisher` | Exact publisher-prefix filter (e.g. `acme`). |
| `limit` | Page size, `1`–`100`, default `25`. |
| `cursor` | Opaque keyset cursor from a previous response's `nextCursor`. |

### Only distributable widgets are listed

A widget appears only when it has a **distributable** version — **approved,
countersigned (a log-anchored release), and not revoked/killed**. This is the
**exact same predicate [resolution](resolution.md) gates on**
(`src/resolution/distributable.ts`), so a widget the catalog shows is one a host can
actually resolve and load — the two never drift. A revoked/killed or never-approved
version is invisible here, exactly as it is excluded from a fragment (SPEC §3, §6).

### Grouping, versions, and manifest fields

Results are one entry per `(publisher, tag)`. Its `versions` are the distributable
versions **newest first** (SemVer order), `latestVersion` is `versions[0]`, and
`name` / `description` / `capabilities` are read from the **latest** version's
manifest. `description` is optional in the manifest, so it is `null` when the
manifest carries none.

### Response

`200 OK`:

```jsonc
{
  "widgets": [
    {
      "publisher": "localdemo",
      "tag": "localdemo-clock",
      "name": "clock",
      "description": null,
      "latestVersion": "0.1.2",
      "versions": ["0.1.2", "0.1.1"],
      "capabilities": [{ "api": "records.read", "scope": "recordType:example" }]
    }
  ],
  "nextCursor": null
}
```

- `capabilities` entries are the manifest `Capability` shape — `{ api, scope? }`.
- `nextCursor` is an opaque string when more results remain, or `null` at the end.
  Pass it back as `cursor` (keyset pagination — the response is stable under
  concurrent publishes, unlike offset paging).

### Errors

Every non-2xx carries the uniform body `{ "error": { "code", "message" } }`.

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_request` | `limit` is not an integer in `1`–`100`. |
| `400` | `invalid_cursor` | `cursor` is not a well-formed pagination cursor. |

### Notes

- SCOPE (registry-v0): the catalog is assembled from the approved artifacts in-app
  (reusing the resolution predicate rather than a bespoke SQL gate, so there is one
  definition of "distributable"). A dedicated indexed query is a later optimization.
- Folds into the OpenAPI spec when that lands.
