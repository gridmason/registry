/**
 * Publisher signature envelope — **structural** validation (SPEC §2).
 *
 * Every published version carries a publisher signature envelope (keyless by
 * default, Sigstore-style, OIDC-bound — SPEC §2). Publish intake (#7) records it
 * with the submitted artifact so the review and countersign stages have it to
 * verify, but intake itself does **not** verify the signature: cryptographic
 * verification against the `@gridmason/protocol` envelope types is deferred to
 * countersign (#10), gated on protocol P-E3 publishing those types. This is a
 * recorded scope decision on the issue.
 *
 * What intake does enforce is a structural shape-check, so a missing or
 * obviously-malformed envelope is refused at the door rather than persisted as
 * junk. The shape checked is the standard DSSE / in-toto attestation envelope
 * (`payloadType` + `payload` + non-empty `signatures[]`), which is the Sigstore
 * envelope this platform targets. The check is intentionally shallow — it proves
 * the shape, never the cryptography — and the envelope is otherwise stored as
 * opaque JSON.
 */

/**
 * A structurally well-formed signature envelope. This is a **shape** guarantee,
 * not a validity proof: the signatures are not verified here. Kept minimal on
 * purpose so it does not diverge from the authoritative protocol type when that
 * lands — the follow-up (P-E3) replaces this with the imported type.
 */
export interface SignatureEnvelope {
  /** Media type of the signed payload (DSSE `payloadType`). */
  readonly payloadType: string;
  /** The signed payload, base64 in the DSSE encoding. Opaque to intake. */
  readonly payload: string;
  /** One or more signatures over the payload. Never verified at intake. */
  readonly signatures: readonly { readonly sig: string; readonly keyid?: string }[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `value` is a structurally well-formed {@link SignatureEnvelope}:
 * a DSSE-shaped object with a non-empty `payloadType`, a non-empty `payload`,
 * and at least one signature entry whose `sig` is a non-empty string. Returns a
 * boolean rather than throwing so the route maps a `false` to a clean
 * `400 invalid_envelope`. It does **not** verify any signature.
 */
export function isStructurallyValidEnvelope(value: unknown): value is SignatureEnvelope {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.payloadType)) return false;
  if (!isNonEmptyString(value.payload)) return false;
  if (!Array.isArray(value.signatures) || value.signatures.length === 0) return false;
  return value.signatures.every(
    (entry) => isPlainObject(entry) && isNonEmptyString(entry.sig),
  );
}
