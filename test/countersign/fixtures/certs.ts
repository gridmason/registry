/**
 * Test-only X.509 leaf-certificate builder.
 *
 * `@gridmason/protocol`'s verify lib parses a **narrow** certificate profile
 * (`verify/signature/der`): a v3 layout whose `tbsCertificate` children are
 * `[0]version, serial, sigAlg, issuer, validity, subject, spki, [3]extensions`,
 * with the Fulcio "OIDC Issuer" extension carrying a *raw* UTF-8 string and a SAN
 * carrying an rfc822/URI name. Neither `@gridmason/protocol` nor Node ships a
 * builder for that shape, so these tests assemble the DER directly — the smallest
 * cert the verifier accepts, plus a real ECDSA-P256 issuer signature over the tbs.
 *
 * This lives under `test/` and is never shipped: production countersign
 * certificates are operator-provisioned (see `docs/countersign.md`), not minted
 * by the registry.
 */
import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

/** DER: encode a definite length (short or long form). */
function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** DER: `tag || length || content`. */
function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), encodeLength(content.length), content);
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ecdsa-with-SHA256 = 1.2.840.10045.4.3.2
const OID_ECDSA_SHA256 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
// Sigstore/Fulcio legacy "OIDC Issuer" = 1.3.6.1.4.1.57264.1.1
const OID_FULCIO_ISSUER = Uint8Array.of(0x2b, 0x06, 0x01, 0x04, 0x01, 0x83, 0xbf, 0x30, 0x01, 0x01);
// subjectAltName = 2.5.29.17
const OID_SAN = Uint8Array.of(0x55, 0x1d, 0x11);

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OID = 0x06;
const UTC_TIME = 0x17;
const CONTEXT_0 = 0xa0;
const CONTEXT_3 = 0xa3;
const SAN_RFC822 = 0x81;

function sigAlgSequence(): Uint8Array {
  return tlv(SEQUENCE, tlv(OID, OID_ECDSA_SHA256));
}

/** The Fulcio issuer extension: `SEQUENCE { OID, OCTET STRING(raw utf8 issuer) }`. */
function fulcioExtension(issuer: string): Uint8Array {
  return tlv(SEQUENCE, concat(tlv(OID, OID_FULCIO_ISSUER), tlv(OCTET_STRING, utf8(issuer))));
}

/** The SAN extension: `SEQUENCE { OID, OCTET STRING( SEQUENCE { [1] email } ) }`. */
function sanExtension(email: string): Uint8Array {
  const generalNames = tlv(SEQUENCE, tlv(SAN_RFC822, utf8(email)));
  return tlv(SEQUENCE, concat(tlv(OID, OID_SAN), tlv(OCTET_STRING, generalNames)));
}

export interface LeafCertOptions {
  /** The subject key whose SPKI the cert certifies. */
  readonly subjectPublicKey: KeyObject;
  /** The key that signs the tbs (the issuing root; the subject key itself when self-signed). */
  readonly issuerPrivateKey: KeyObject;
  /** Fulcio OIDC-issuer extension value (publisher leaf only). */
  readonly fulcioIssuer?: string;
  /** SAN rfc822 (email) identity (publisher leaf only). */
  readonly sanEmail?: string;
}

/** Build a DER X.509 leaf certificate matching the protocol verifier's profile. */
export function buildLeafCertificate(options: LeafCertOptions): Uint8Array {
  const spki = new Uint8Array(
    options.subjectPublicKey.export({ format: 'der', type: 'spki' }),
  );

  const version = tlv(CONTEXT_0, tlv(INTEGER, Uint8Array.of(0x02))); // v3
  const serial = tlv(INTEGER, Uint8Array.of(0x01));
  const sigAlg = sigAlgSequence();
  const emptyName = tlv(SEQUENCE, new Uint8Array(0));
  const validity = tlv(
    SEQUENCE,
    concat(tlv(UTC_TIME, utf8('700101000000Z')), tlv(UTC_TIME, utf8('491231235959Z'))),
  );

  const extensionList: Uint8Array[] = [];
  if (options.fulcioIssuer !== undefined) extensionList.push(fulcioExtension(options.fulcioIssuer));
  if (options.sanEmail !== undefined) extensionList.push(sanExtension(options.sanEmail));
  const extensions = tlv(CONTEXT_3, tlv(SEQUENCE, concat(...extensionList)));

  const tbs = tlv(
    SEQUENCE,
    concat(version, serial, sigAlg, emptyName, validity, emptyName, spki, extensions),
  );

  // The issuing root signs the tbs bytes (ECDSA P-256 / SHA-256, DER encoding).
  const signature = new Uint8Array(
    sign('sha256', tbs, { key: options.issuerPrivateKey, dsaEncoding: 'der' }),
  );
  const signatureValue = tlv(BIT_STRING, concat(Uint8Array.of(0x00), signature));

  return tlv(SEQUENCE, concat(tbs, sigAlg, signatureValue));
}

/** Generate an ECDSA P-256 key pair. */
export function generateP256(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

/** Wrap DER bytes as a PEM block. */
export function derToPem(der: Uint8Array, label: string): string {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** SPKI DER of a public key (the pinned-root material for the verifier). */
export function spkiDer(publicKey: KeyObject): Uint8Array {
  return new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));
}

/** Re-import a public key from its SPKI DER (round-trips builder output). */
export function publicKeyFromSpki(spki: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
}
