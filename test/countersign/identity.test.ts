/**
 * Countersign key custody + separation (#10, SPEC §2, §4a): the countersign key
 * is loaded only from its own custody-controlled config fields, never from a
 * review-lane credential; a misconfigured key is a hard failure, not a silent skip.
 */
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import {
  CountersignConfigError,
  isCountersignConfigured,
  loadCountersignIdentity,
} from '../../src/countersign/identity.js';
import { generateP256, buildLeafCertificate, derToPem } from './fixtures/certs.js';
import { makeCountersignFixture } from './fixtures/envelope.js';

describe('countersign identity', () => {
  it('loads a signing capability from custody PEMs', () => {
    const identity = loadCountersignIdentity(makeCountersignFixture());
    expect(identity).not.toBeNull();
    const sig = identity!.sign(new Uint8Array([1, 2, 3]));
    // ECDSA P-256 IEEE-P1363 is a fixed 64 bytes (r || s).
    expect(sig.length).toBe(64);
    expect(identity!.certificateDer.length).toBeGreaterThan(0);
  });

  it('returns null when no countersign key is configured', () => {
    expect(isCountersignConfigured({ privateKeyPem: '', certificatePem: '' })).toBe(false);
    expect(loadCountersignIdentity({ privateKeyPem: '', certificatePem: '' })).toBeNull();
  });

  it('throws on an invalid private key rather than skipping', () => {
    const fixture = makeCountersignFixture();
    expect(() =>
      loadCountersignIdentity({ privateKeyPem: 'not a pem', certificatePem: fixture.certificatePem }),
    ).toThrow(CountersignConfigError);
  });

  it('throws when the certificate does not match the private key', () => {
    // A certificate for one key paired with a different private key must be refused.
    const keyA = generateP256();
    const keyB = generateP256();
    const certForA = buildLeafCertificate({
      subjectPublicKey: keyA.publicKey,
      issuerPrivateKey: keyA.privateKey,
    });
    expect(() =>
      loadCountersignIdentity({
        privateKeyPem: keyB.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
        certificatePem: derToPem(certForA, 'CERTIFICATE'),
      }),
    ).toThrow(CountersignConfigError);
  });

  it('sources the countersign key from a config field distinct from reviewer identities', () => {
    const fixture = makeCountersignFixture();
    // Reviewer identities and the countersign key come from *different* env vars,
    // so the countersign key can never be a reviewer credential (SPEC §2).
    const config = loadConfig({
      REVIEW_REVIEWER_IDENTITIES: 'https%3A%2F%2Fissuer https%3A%2F%2Fissuer%2Freviewer',
      COUNTERSIGN_PRIVATE_KEY: fixture.privateKeyPem,
      COUNTERSIGN_CERTIFICATE: fixture.certificatePem,
    });
    expect(config.review.reviewerIdentities.length).toBeGreaterThan(0);
    // The countersign identity is derived purely from the custody fields.
    const identity = loadCountersignIdentity(config.countersign);
    expect(identity).not.toBeNull();
    // The reviewer roster is not part of the countersign config surface at all.
    expect(Object.keys(config.countersign)).toEqual(['privateKeyPem', 'certificatePem']);
  });

  it('does not load a key when only the reviewer roster is configured', () => {
    const config = loadConfig({ REVIEW_REVIEWER_IDENTITIES: 'https%3A%2F%2Fissuer reviewer-1' });
    expect(loadCountersignIdentity(config.countersign)).toBeNull();
  });
});
