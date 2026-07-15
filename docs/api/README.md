# Registry API reference

The registry exposes a small control-plane API over HTTP. Each document below
covers one surface — its endpoints, request and response shapes, and the
authorization it enforces. Configuration for these surfaces (identity, review
roster, countersign key, operator set) lives in [`../config.md`](../config.md).

| Document | Surface |
|---|---|
| [`publish.md`](publish.md) | Artifact upload — an authenticated publisher uploads a content-hashed, immutable artifact and its signature envelope; the registry records it as **submitted** for review. |
| [`publisher.md`](publisher.md) | Publisher records + prefix registration — the identity/ownership foundation the publish and review lanes check against. |
| [`artifact-status.md`](artifact-status.md) | Review status + appeal — the publisher-facing surface the CLI polls after upload to read the review outcome and route a rejection to a second reviewer. |
| [`resolution.md`](resolution.md) | Resolution — turns a host's enabled-remote snapshot into a hash-pinned import-map fragment host shells load widgets from. |
| [`revocation-feed.md`](revocation-feed.md) | Signed revocation & kill feed — the registry's published distribution state (whether an already-published artifact is still loadable) that hosts poll. |
| [`audit.md`](audit.md) | Audit log — the operator-gated query endpoint for the auditable trail of every registry state transition. |
