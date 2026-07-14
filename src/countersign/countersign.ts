/**
 * Registry countersignature over an approved publisher envelope (SPEC §2, FR-5).
 *
 * The publisher submits a dual-signature envelope (`@gridmason/protocol`
 * {@link SignatureEnvelope}) carrying only its **authorship** signature — a
 * Sigstore-keyless publisher signature over the canonical release subject. Once
 * review passes, the registry applies the **approval** half: a countersignature
 * over the exact publisher signature it approved, with the separately-held
 * countersign key ({@link CountersignIdentity}). The result is the complete
 * envelope `verifySignatureEnvelope` accepts — both signatures binding.
 *
 * This module does two things and no more: it **narrows** the opaquely-stored
 * publisher envelope (intake kept it as `unknown`, structural-only — see
 * `../artifact/envelope`) into the protocol shape the countersignature needs, and
 * it **produces `registrySig`**. It deliberately does *not* verify the publisher
 * signature or anchor the log — the stage (`./stage`) composes those around it.
 *
 * What the countersignature covers: the protocol binds the registry signature to
 * the publisher signature's raw bytes (`verifyEcdsa(registryKey, countersig,
 * publisherSigBytes)`), so approval is bound to that exact publisher signature and
 * cannot be lifted onto another. We sign the decoded 64-byte P-256 publisher
 * signature verbatim.
 */
import type { SignatureEnvelope } from '@gridmason/protocol';

import type { CountersignIdentity } from './identity.js';

/**
 * A publisher-signed envelope awaiting countersignature: the protocol
 * {@link SignatureEnvelope} with the authorship half present and the approval
 * half (`registrySig`) and log-inclusion transport not yet filled — the registry
 * fills those. `logInclusion` is optional here because the publisher cannot know
 * the log entry at signing time (the registry creates it at anchor time).
 */
export type PublisherEnvelope = Omit<SignatureEnvelope, 'registrySig' | 'logInclusion'> &
  Partial<Pick<SignatureEnvelope, 'logInclusion'>>;

/** Why {@link parsePublisherEnvelope} rejected a stored envelope. */
export type PublisherEnvelopeError =
  | 'not-an-object'
  | 'malformed-format-version'
  | 'malformed-subject'
  | 'malformed-publisher-signature'
  | 'already-countersigned';

export type ParsePublisherEnvelopeResult =
  | { readonly ok: true; readonly envelope: PublisherEnvelope }
  | { readonly ok: false; readonly reason: PublisherEnvelopeError };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isObject(value) && Object.values(value).every((v) => typeof v === 'string')
  );
}

/**
 * Narrow a stored, opaque publisher envelope into the {@link PublisherEnvelope}
 * shape the countersignature needs. Structural only — it proves the fields exist
 * and are the right types (so the countersignature is well-formed), never that
 * the publisher signature is cryptographically valid (that is the host's job, and
 * the stage re-checks it via the protocol verify lib). A stored envelope that
 * already carries a `registrySig` is refused: countersigning is applied once.
 */
export function parsePublisherEnvelope(value: unknown): ParsePublisherEnvelopeResult {
  if (!isObject(value)) return { ok: false, reason: 'not-an-object' };

  if (!isNonEmptyString(value.formatVersion) || !/^\d+\.\d+$/.test(value.formatVersion)) {
    return { ok: false, reason: 'malformed-format-version' };
  }

  const subject = value.subject;
  if (
    !isObject(subject) ||
    !isNonEmptyString(subject.artifact) ||
    !isNonEmptyString(subject.releaseHash)
  ) {
    return { ok: false, reason: 'malformed-subject' };
  }

  const pub = value.publisherSig;
  if (
    !isObject(pub) ||
    pub.alg !== 'ES256' ||
    !isNonEmptyString(pub.cert) ||
    !isNonEmptyString(pub.issuer) ||
    !isStringRecord(pub.subjectClaims) ||
    !isNonEmptyString(pub.sig)
  ) {
    return { ok: false, reason: 'malformed-publisher-signature' };
  }

  if (value.registrySig !== undefined) {
    return { ok: false, reason: 'already-countersigned' };
  }

  const envelope: PublisherEnvelope = {
    formatVersion: value.formatVersion,
    subject: {
      artifact: subject.artifact,
      releaseHash: subject.releaseHash as PublisherEnvelope['subject']['releaseHash'],
    },
    publisherSig: {
      alg: 'ES256',
      cert: pub.cert,
      issuer: pub.issuer,
      subjectClaims: pub.subjectClaims,
      sig: pub.sig,
    },
    ...(isObject(value.logInclusion)
      ? { logInclusion: value.logInclusion as unknown as SignatureEnvelope['logInclusion'] }
      : {}),
  };
  return { ok: true, envelope };
}

/**
 * Apply the registry countersignature to a parsed publisher envelope, returning
 * the envelope with `registrySig` populated. The countersignature is over the
 * publisher signature's raw 64-byte bytes (the value the protocol binds approval
 * to). `logInclusion` is left as-is; the stage sets it once the release is logged.
 */
/** A publisher envelope with the registry countersignature applied (required). */
export type CountersignedEnvelope = PublisherEnvelope & {
  readonly registrySig: NonNullable<SignatureEnvelope['registrySig']>;
};

export function countersignEnvelope(
  envelope: PublisherEnvelope,
  identity: CountersignIdentity,
): CountersignedEnvelope {
  const publisherSigBytes = new Uint8Array(
    Buffer.from(envelope.publisherSig.sig, 'base64'),
  );
  const countersig = identity.sign(publisherSigBytes);
  return {
    ...envelope,
    registrySig: {
      alg: 'ES256',
      cert: Buffer.from(identity.certificateDer).toString('base64'),
      sig: Buffer.from(countersig).toString('base64'),
    },
  };
}
