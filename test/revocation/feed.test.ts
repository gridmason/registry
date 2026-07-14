/**
 * Revocation-feed document + signature (#14, FR-8).
 *
 * Two acceptance checks the issue names:
 *  - the protocol `evaluateFreshness` accepts a produced feed (fresh + stale);
 *  - the feed is signed and verifies against the registry trust root (the pinned
 *    countersign public key), with the seq carried through as the feed version.
 */
import { createVerify, sign } from 'node:crypto';

import { evaluateFreshness, type Cursor } from '@gridmason/protocol';
import { describe, expect, it } from 'vitest';

import type { CountersignIdentity } from '../../src/countersign/identity.js';
import {
  buildRevocationFeed,
  canonicalFeedBytes,
  REVOCATION_FEED_FORMAT_VERSION,
  signRevocationFeed,
} from '../../src/revocation/feed.js';
import type { FeedSnapshot } from '../../src/revocation/store.js';
import { generateP256, buildLeafCertificate, spkiDer, publicKeyFromSpki } from '../countersign/fixtures/certs.js';

const REGISTRY_ID = 'registry.test';

/** A countersign identity backed by a self-signed P-256 leaf (the trust root a host pins). */
function makeIdentity(): CountersignIdentity {
  const { publicKey, privateKey } = generateP256();
  const certificateDer = buildLeafCertificate({
    subjectPublicKey: publicKey,
    issuerPrivateKey: privateKey,
  });
  return {
    sign: (message) =>
      new Uint8Array(sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' })),
    certificateDer,
    publicKeySpkiDer: spkiDer(publicKey),
  };
}

const snapshot: FeedSnapshot = {
  seq: 3,
  entries: [
    { seq: 2, artifact: 'acme-chart@2.0.0', state: 'revoked', severity: 'medium', reason: 'bug' },
    { seq: 3, artifact: 'acme-clock@1.0.0', state: 'killed', severity: 'critical', reason: 'exploited' },
  ],
};

describe('revocation feed', () => {
  it('builds a protocol feed evaluateFreshness accepts while fresh', () => {
    const issuedAt = 1_000_000;
    const feed = buildRevocationFeed({ registryId: REGISTRY_ID, snapshot, issuedAt, ttlSeconds: 3600 });
    expect(feed.formatVersion).toBe(REVOCATION_FEED_FORMAT_VERSION);
    expect(feed.seq).toBe(3);
    expect(feed.entries).toHaveLength(2);

    const cursor: Cursor = { registryId: REGISTRY_ID, seq: -1 };
    // Within TTL: fresh, and the killed/revoked artifacts come back blocked.
    const verdict = evaluateFreshness(feed, cursor, issuedAt + 60_000);
    expect(verdict.code).toBe('fresh');
    expect(verdict.ok).toBe(true);
    expect(verdict.nextSeq).toBe(3);
    expect(verdict.blocked).toEqual([
      { artifact: 'acme-chart@2.0.0', state: 'revoked', severity: 'medium' },
      { artifact: 'acme-clock@1.0.0', state: 'killed', severity: 'critical' },
    ]);
  });

  it('is stale (fail-closed) once now is past issuedAt + ttl', () => {
    const issuedAt = 1_000_000;
    const feed = buildRevocationFeed({ registryId: REGISTRY_ID, snapshot, issuedAt, ttlSeconds: 3600 });
    const cursor: Cursor = { registryId: REGISTRY_ID, seq: -1 };
    const verdict = evaluateFreshness(feed, cursor, issuedAt + 3600 * 1000 + 1);
    expect(verdict.code).toBe('stale');
    expect(verdict.ok).toBe(false);
  });

  it('signs the feed so it verifies against the pinned countersign key', () => {
    const identity = makeIdentity();
    const feed = buildRevocationFeed({
      registryId: REGISTRY_ID,
      snapshot,
      issuedAt: 1_000_000,
      ttlSeconds: 3600,
    });
    const signed = signRevocationFeed(feed, identity);
    expect(signed.feed).toEqual(feed);
    expect(signed.signature.alg).toBe('ES256');

    // A host reconstructs the canonical bytes from the feed it received and checks
    // the signature against the trust root it pinned (the countersign public key).
    const verifier = createVerify('sha256');
    verifier.update(canonicalFeedBytes(signed.feed));
    const ok = verifier.verify(
      { key: publicKeyFromSpki(identity.publicKeySpkiDer), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signed.signature.sig, 'base64'),
    );
    expect(ok).toBe(true);

    // A tampered feed (a removed entry) no longer verifies under the same signature.
    const tampered = { ...signed.feed, entries: [] };
    const bad = createVerify('sha256');
    bad.update(canonicalFeedBytes(tampered));
    expect(
      bad.verify(
        { key: publicKeyFromSpki(identity.publicKeySpkiDer), dsaEncoding: 'ieee-p1363' },
        Buffer.from(signed.signature.sig, 'base64'),
      ),
    ).toBe(false);
  });
});
