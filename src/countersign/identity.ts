/**
 * Registry countersign key custody (SPEC §2, §4a).
 *
 * The registry countersignature — the "approval" half of the dual signature
 * (SPEC §2) — is applied with a key **held separately from review staff**. This
 * module is the only place that key material is loaded, and it is loaded from a
 * custody-controlled secret ({@link CountersignConfig}), never from any
 * review-lane identity: an {@link CountersignIdentity} is a signing capability
 * plus the certificate that rides in the envelope, and nothing else. The key
 * separation the SPEC requires is therefore structural — the countersign path
 * cannot reach a reviewer credential because it only ever sees this config.
 *
 * The signature primitive is `node:crypto` (this is the server, not the
 * isomorphic verify lib): ECDSA P-256 / SHA-256, emitted in the IEEE-P1363
 * (`r || s`, 64-byte) form `@gridmason/protocol`'s `verifySignatureEnvelope`
 * consumes. The certificate is a standard X.509 leaf (self-signed for a
 * self-hoster, or issued by the operator's offline root); hosts pin its issuing
 * root as a countersign root (`docs/countersign.md`).
 */
import { X509Certificate, createPrivateKey, sign, type KeyObject } from 'node:crypto';

/** Why {@link loadCountersignIdentity} refused the configured key material. */
export type CountersignKeyError =
  | { readonly kind: 'not-configured' }
  | { readonly kind: 'invalid'; readonly message: string };

export class CountersignConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CountersignConfigError';
  }
}

/**
 * A loaded registry countersign key: the capability to produce the P-256/SHA-256
 * countersignature plus the certificate bytes it is presented with. Immutable and
 * side-effect free apart from the signing call.
 */
export interface CountersignIdentity {
  /**
   * Sign `message` with the countersign private key, returning the 64-byte
   * IEEE-P1363 ECDSA signature the protocol envelope carries.
   */
  sign(message: Uint8Array): Uint8Array;
  /** DER bytes of the countersign X.509 certificate (base64-encoded into the envelope). */
  readonly certificateDer: Uint8Array;
  /**
   * DER `SubjectPublicKeyInfo` of the certificate's public key — the material a
   * host pins as a countersign root when the certificate is self-signed. Exposed
   * so trust-root wiring and tests can derive the pin without re-parsing the cert.
   */
  readonly publicKeySpkiDer: Uint8Array;
}

/** True when a countersign key is present in config (both key and cert set). */
export function isCountersignConfigured(config: {
  readonly privateKeyPem: string;
  readonly certificatePem: string;
}): boolean {
  return config.privateKeyPem !== '' && config.certificatePem !== '';
}

function assertP256(key: KeyObject, what: string): void {
  if (key.asymmetricKeyType !== 'ec') {
    throw new CountersignConfigError(`countersign ${what} must be an EC key`);
  }
  // `namedCurve` is exposed on EC KeyObjects; P-256 is `prime256v1` in OpenSSL's
  // naming. The verify lib accepts only ES256 (P-256), so anything else is refused
  // here rather than producing a countersignature no host can check.
  const details = key.asymmetricKeyDetails;
  if (details?.namedCurve !== 'prime256v1') {
    throw new CountersignConfigError(
      `countersign ${what} must use curve P-256 (prime256v1), got ${details?.namedCurve ?? 'unknown'}`,
    );
  }
}

/**
 * Load the countersign identity from custody config. Returns `null` when no key
 * is configured (the stage does not mount); throws {@link CountersignConfigError}
 * when a key *is* configured but is unusable — a misconfigured custody secret is
 * a boot-time failure, never a silent skip that would ship unapproved releases.
 */
export function loadCountersignIdentity(config: {
  readonly privateKeyPem: string;
  readonly certificatePem: string;
}): CountersignIdentity | null {
  if (!isCountersignConfigured(config)) return null;

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(config.privateKeyPem);
  } catch (err) {
    throw new CountersignConfigError(
      `countersign private key is not a valid PEM private key: ${(err as Error).message}`,
    );
  }
  assertP256(privateKey, 'private key');

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(config.certificatePem);
  } catch (err) {
    throw new CountersignConfigError(
      `countersign certificate is not a valid PEM X.509 certificate: ${(err as Error).message}`,
    );
  }

  const publicKey = certificate.publicKey;
  assertP256(publicKey, 'certificate key');

  // The certificate must present the countersign key's public half; otherwise the
  // countersignature would verify under a key no host expects. `checkPrivateKey`
  // is the cheapest proof the pair belongs together.
  if (!certificate.checkPrivateKey(privateKey)) {
    throw new CountersignConfigError(
      'countersign certificate does not match the configured private key',
    );
  }

  const certificateDer = new Uint8Array(certificate.raw);
  const publicKeySpkiDer = new Uint8Array(
    publicKey.export({ format: 'der', type: 'spki' }),
  );

  return {
    sign(message: Uint8Array): Uint8Array {
      // `ieee-p1363` yields the fixed-width r||s form (64 bytes for P-256) the
      // WebCrypto-based verify lib expects; the default DER encoding would not verify.
      const signature = sign('sha256', message, {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      });
      return new Uint8Array(signature);
    },
    certificateDer,
    publicKeySpkiDer,
  };
}
