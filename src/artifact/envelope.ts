/**
 * Publisher signature envelope — **structural** validation at intake (SPEC §2).
 *
 * Every published version carries a publisher signature envelope (keyless by
 * default, Sigstore-style, OIDC-bound — SPEC §2). Publish intake (#7) records it
 * with the submitted artifact so the review and countersign stages have it to
 * verify; intake itself does **not** verify the signature cryptographically — that
 * is the countersign stage (#10), which applies the registry approval half and
 * whose host-side `@gridmason/protocol` verify a host runs before loading.
 *
 * What intake enforces is that the envelope is the **`@gridmason/protocol`
 * `SignatureEnvelope` publisher half** — `{ formatVersion, subject{ artifact,
 * releaseHash }, publisherSig{ alg, cert, issuer, subjectClaims, sig } }` — the
 * shape `@gridmason/cli` (≥ 0.6.0) uploads and the countersign stage consumes. It
 * does this by **reusing the countersign stage's own parser**
 * ({@link parsePublisherEnvelope}), so the guarantee is exact: an envelope intake
 * accepts is one countersign can parse — there is no second, drifting definition.
 * The check is still structural (it proves the shape and field types, never the
 * cryptography); the envelope is otherwise stored as opaque JSON.
 *
 * **Breaking change (registry#55, owner decision on gridmason/cli#70).** Intake
 * previously accepted the bare **DSSE** shape (`payloadType` + `payload` +
 * `signatures[]`) that `@gridmason/cli` ≤ 0.5.x uploaded. The owner decided the
 * CLI emits the protocol `SignatureEnvelope`, so DSSE is no longer accepted: an
 * upload from `@gridmason/cli` ≤ 0.5.x is now refused `400 invalid_envelope`.
 * Publishers upgrade to `@gridmason/cli` ≥ 0.6.0. See `docs/api/publish.md`.
 */
import { parsePublisherEnvelope } from '../countersign/countersign.js';

/**
 * True when `value` is a structurally well-formed `@gridmason/protocol`
 * `SignatureEnvelope` publisher half — decided by the countersign stage's parser,
 * so intake and countersign never diverge on "what is a valid envelope". Returns a
 * boolean rather than throwing so the route maps a `false` to a clean
 * `400 invalid_envelope`. It does **not** verify any signature. A publisher-half
 * envelope carries no `registrySig` (the registry adds that at countersign); one
 * that already does is rejected here, as it is by the parser.
 */
export function isStructurallyValidEnvelope(value: unknown): boolean {
  return parsePublisherEnvelope(value).ok;
}
