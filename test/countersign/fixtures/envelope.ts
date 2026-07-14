/**
 * Higher-level countersign fixtures: a complete publisher-signed envelope and a
 * countersign identity, both built from the low-level cert builder (`./certs`).
 *
 * The publisher envelope is exactly what publish intake would have stored — a
 * Sigstore-keyless publisher signature over the canonical release subject, with
 * no registry countersignature yet — so the stage countersigns a realistic input.
 * The countersign fixture returns PEMs so tests exercise the production
 * `loadCountersignIdentity` path, and the self-signed cert's SPKI is the pin a
 * host would trust as the countersign root.
 */
import { sign, type KeyObject } from 'node:crypto';

import { canonicalize, hashBytes } from '@gridmason/protocol';
import type { MultihashString, ReleaseDoc, ReleaseHashMap } from '@gridmason/protocol';

import { RELEASE_DOC_FORMAT_VERSION } from '../../../src/release/release-doc.js';
import {
  buildLeafCertificate,
  derToPem,
  generateP256,
  spkiDer,
} from './certs.js';

const hex = (byte: number): MultihashString =>
  (`sha2-256:${byte.toString(16).padStart(2, '0').repeat(32)}`) as MultihashString;

export interface PublisherFixtureOptions {
  readonly artifactId?: string;
  readonly files?: ReleaseHashMap;
  readonly issuer?: string;
  readonly email?: string;
}

export interface PublisherFixture {
  /** Version-qualified artifact id (`subject.artifact`). */
  readonly artifactId: string;
  /** The content-hash map the artifact record carries (`contentHashes`). */
  readonly files: ReleaseHashMap;
  /** The stored publisher envelope (publisher signature only — no `registrySig`). */
  readonly publisherEnvelope: Record<string, unknown>;
  readonly issuer: string;
  readonly email: string;
  /** The publisher CA root SPKI a host pins to anchor authorship. */
  readonly publisherCASpki: Uint8Array;
  /** The signed release document + its canonical bytes (what `subject.releaseHash` covers). */
  readonly releaseDoc: ReleaseDoc;
  readonly releaseBytes: Uint8Array;
}

/** Build a complete publisher-signed envelope over a fresh release document. */
export async function makePublisherFixture(
  options: PublisherFixtureOptions = {},
): Promise<PublisherFixture> {
  const artifactId = options.artifactId ?? 'acme-clock@1.2.0';
  const files: ReleaseHashMap =
    options.files ?? { 'manifest.json': hex(0xab), 'entry.js': hex(0xcd) };
  const issuer = options.issuer ?? 'https://accounts.example.com';
  const email = options.email ?? 'dev@acme.example';

  const releaseDoc: ReleaseDoc = {
    formatVersion: RELEASE_DOC_FORMAT_VERSION,
    artifact: artifactId,
    files,
  };
  const releaseBytes = canonicalize(releaseDoc);
  const releaseHash = await hashBytes(releaseBytes);

  const subject = { artifact: artifactId, releaseHash };
  const subjectBytes = canonicalize(subject);

  const ca = generateP256();
  const publisher = generateP256();
  const leafDer = buildLeafCertificate({
    subjectPublicKey: publisher.publicKey,
    issuerPrivateKey: ca.privateKey,
    fulcioIssuer: issuer,
    sanEmail: email,
  });
  const publisherSig = signP1363(publisher.privateKey, subjectBytes);

  const publisherEnvelope: Record<string, unknown> = {
    formatVersion: '1.0',
    subject,
    publisherSig: {
      alg: 'ES256',
      cert: Buffer.from(leafDer).toString('base64'),
      issuer,
      subjectClaims: { email },
      sig: Buffer.from(publisherSig).toString('base64'),
    },
  };

  return {
    artifactId,
    files,
    publisherEnvelope,
    issuer,
    email,
    publisherCASpki: spkiDer(ca.publicKey),
    releaseDoc,
    releaseBytes,
  };
}

export interface CountersignFixture {
  readonly privateKeyPem: string;
  readonly certificatePem: string;
  /** The self-signed countersign cert's SPKI — the host's pinned countersign root. */
  readonly countersignRootSpki: Uint8Array;
}

/** Build a countersign key + self-signed certificate, returned as custody PEMs. */
export function makeCountersignFixture(): CountersignFixture {
  const key = generateP256();
  const certDer = buildLeafCertificate({
    subjectPublicKey: key.publicKey,
    issuerPrivateKey: key.privateKey,
  });
  return {
    privateKeyPem: key.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    certificatePem: derToPem(certDer, 'CERTIFICATE'),
    countersignRootSpki: spkiDer(key.publicKey),
  };
}

function signP1363(privateKey: KeyObject, message: Uint8Array): Uint8Array {
  return new Uint8Array(sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' }));
}
