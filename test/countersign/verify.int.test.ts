/**
 * ACCEPTANCE (#10, FR-5/FR-12): an approved artifact's countersigned envelope
 * verifies via `@gridmason/protocol` — both signatures, the content-hash binding,
 * **and** transparency-log inclusion — exactly as a host would check it before
 * loading.
 *
 * The stage runs against the in-process RFC 6962 log; the resulting envelope +
 * release document + log entry are then fed to the protocol verify lib three
 * ways: the dual-signature check, the log-inclusion check, and the full
 * `verifyRelease` orchestration (trust root → signatures → log). All must pass.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  verifyLogInclusion,
  verifyRelease,
  verifySignatureEnvelope,
  type TrustRootPin,
} from '@gridmason/protocol';

import type { ArtifactRecord } from '../../src/artifact/types.js';
import { noopAuditSink, setAuditSink, type AuditEvent } from '../../src/audit/index.js';
import { loadCountersignIdentity } from '../../src/countersign/identity.js';
import { createCountersignStage } from '../../src/countersign/stage.js';
import { InMemoryReleaseDocStore } from '../../src/release/store.js';
import { InMemoryTransparencyLog } from '../../src/sigstore/log.js';
import { makeCountersignFixture, makePublisherFixture } from './fixtures/envelope.js';

const REGISTRY_ID = 'registry.test';

function artifactFrom(publisherEnvelope: Record<string, unknown>, files: ArtifactRecord['contentHashes']): ArtifactRecord {
  return {
    id: 'artifact-1',
    publisherId: 'pub-1',
    tag: 'acme-clock',
    version: '1.2.0',
    contentHashes: files,
    sourceArchiveRef: null,
    envelope: publisherEnvelope,
    state: 'approved',
    createdAt: new Date(),
  };
}

describe('countersigned release verifies via @gridmason/protocol', () => {
  let events: AuditEvent[];

  beforeEach(() => {
    events = [];
    setAuditSink({ emit: (e) => events.push(e) });
  });
  afterEach(() => setAuditSink(noopAuditSink));

  it('produces an envelope + log entry that pass every protocol check', async () => {
    const publisher = await makePublisherFixture();
    const countersign = makeCountersignFixture();
    const identity = loadCountersignIdentity(countersign);
    expect(identity).not.toBeNull();

    const log = new InMemoryTransparencyLog(REGISTRY_ID);
    const releaseDocStore = new InMemoryReleaseDocStore();
    const stage = createCountersignStage({
      identity: identity!,
      transparencyLog: log,
      releaseDocStore,
    });

    const artifact = artifactFrom(publisher.publisherEnvelope, publisher.files);
    const result = await stage.run({ artifact, waiverUsed: false });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 1. Dual-signature: both publisher and registry signatures + hash binding.
    const trust = {
      issuerAllowlist: [publisher.issuer],
      publisherCARoots: [publisher.publisherCASpki],
      countersignRoots: [countersign.countersignRootSpki],
    };
    const sigVerdict = await verifySignatureEnvelope({
      envelope: result.envelope,
      releaseBytes: publisher.releaseBytes,
      trust,
    });
    expect(sigVerdict.reason).toBe('ok');

    // 2. Transparency-log inclusion against the log's pinned checkpoint key.
    const logVerdict = await verifyLogInclusion(result.logEntry, log.publicKey());
    expect(logVerdict.reason).toBe('ok');

    // 3. Full verifyRelease orchestration: trust root → signatures → log.
    const pins: TrustRootPin[] = [
      { registryId: REGISTRY_ID, root: 'cs-root', channel: 'build-time' },
    ];
    const trustRoot = {
      formatVersion: '1.0',
      registryId: REGISTRY_ID,
      countersignRoots: ['cs-root'],
      issuerAllowlist: [publisher.issuer],
      logPublicKeys: ['log-key'],
      notBefore: 0,
      notAfter: Date.now() + 3_600_000,
    };
    const releaseVerdict = await verifyRelease({
      release: result.releaseDoc.releaseDoc,
      envelope: result.envelope,
      trustRoot,
      pins,
      publisherCARoots: [publisher.publisherCASpki],
      countersignRoots: [countersign.countersignRootSpki],
      logEntry: result.logEntry,
      logPublicKey: log.publicKey(),
      now: Date.now(),
    });
    expect(releaseVerdict.ok).toBe(true);

    // The sign + emission transitions were audited (FR-12).
    expect(events.map((e) => e.action)).toEqual([
      'release.countersigned',
      'release.logged',
    ]);
    expect(events.every((e) => e.actor === 'registry:countersign')).toBe(true);
  });
});
