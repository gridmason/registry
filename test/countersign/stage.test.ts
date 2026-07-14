/**
 * Countersign stage unit paths (#10): the flagship-waiver flag lands in the log
 * leaf and on the release doc (SPEC §4a), and the stage refuses — never
 * countersigns — an unusable envelope or a release whose rebuilt hash does not
 * match the signed subject.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ArtifactRecord } from '../../src/artifact/types.js';
import { noopAuditSink, setAuditSink, type AuditEvent } from '../../src/audit/index.js';
import { loadCountersignIdentity } from '../../src/countersign/identity.js';
import { createCountersignStage } from '../../src/countersign/stage.js';
import { InMemoryReleaseDocStore } from '../../src/release/store.js';
import { InMemoryTransparencyLog } from '../../src/sigstore/log.js';
import { makeCountersignFixture, makePublisherFixture } from './fixtures/envelope.js';

function artifact(overrides: Partial<ArtifactRecord> & Pick<ArtifactRecord, 'envelope' | 'contentHashes'>): ArtifactRecord {
  return {
    id: 'artifact-1',
    publisherId: 'pub-1',
    tag: 'acme-clock',
    version: '1.2.0',
    sourceArchiveRef: null,
    state: 'approved',
    createdAt: new Date(),
    ...overrides,
  };
}

function makeStage() {
  const countersign = makeCountersignFixture();
  const identity = loadCountersignIdentity(countersign)!;
  const log = new InMemoryTransparencyLog('registry.test');
  const releaseDocStore = new InMemoryReleaseDocStore();
  return {
    stage: createCountersignStage({ identity, transparencyLog: log, releaseDocStore }),
    log,
    releaseDocStore,
  };
}

describe('countersign stage', () => {
  let events: AuditEvent[];
  beforeEach(() => {
    events = [];
    setAuditSink({ emit: (e) => events.push(e) });
  });
  afterEach(() => setAuditSink(noopAuditSink));

  it('flags a waiver release in the log leaf and on the release doc', async () => {
    const publisher = await makePublisherFixture();
    const { stage, releaseDocStore } = makeStage();

    const result = await stage.run({
      artifact: artifact({ envelope: publisher.publisherEnvelope, contentHashes: publisher.files }),
      waiverUsed: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The waiver flag rides inside the logged leaf, visible to any auditor.
    const leaf = JSON.parse(Buffer.from(result.logEntry.canonicalBody, 'base64').toString('utf8'));
    expect(leaf.waiver).toBe(true);

    const stored = await releaseDocStore.findByArtifact('artifact-1');
    expect(stored?.waiverFlagged).toBe(true);
  });

  it('does not flag a normal (reviewer≠author) release', async () => {
    const publisher = await makePublisherFixture();
    const { stage, releaseDocStore } = makeStage();

    const result = await stage.run({
      artifact: artifact({ envelope: publisher.publisherEnvelope, contentHashes: publisher.files }),
      waiverUsed: false,
    });
    expect(result.ok).toBe(true);
    const leaf = JSON.parse(
      Buffer.from((result as { logEntry: { canonicalBody: string } }).logEntry.canonicalBody, 'base64').toString('utf8'),
    );
    expect(leaf.waiver).toBe(false);
    expect((await releaseDocStore.findByArtifact('artifact-1'))?.waiverFlagged).toBe(false);
  });

  it('carries the log inclusion into the completed envelope', async () => {
    const publisher = await makePublisherFixture();
    const { stage } = makeStage();
    const result = await stage.run({
      artifact: artifact({ envelope: publisher.publisherEnvelope, contentHashes: publisher.files }),
      waiverUsed: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // verifyRelease requires the envelope to name the supplied log entry.
    expect(result.envelope.logInclusion.logId).toBe(result.logEntry.logId);
    expect(result.envelope.logInclusion.index).toBe(result.logEntry.index);
  });

  it('refuses an unusable publisher envelope without countersigning', async () => {
    const { stage, releaseDocStore } = makeStage();
    const result = await stage.run({
      artifact: artifact({ envelope: { not: 'an envelope' }, contentHashes: {} }),
      waiverUsed: false,
    });
    expect(result).toEqual({ ok: false, reason: 'envelope-unusable' });
    expect(await releaseDocStore.findByArtifact('artifact-1')).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('refuses when the rebuilt release hash does not match the signed subject', async () => {
    const publisher = await makePublisherFixture();
    const { stage, releaseDocStore } = makeStage();
    // Content hashes drifted from what the publisher signed → hash binding fails.
    const result = await stage.run({
      artifact: artifact({
        envelope: publisher.publisherEnvelope,
        contentHashes: { 'entry.js': `sha2-256:${'ff'.repeat(32)}` as never },
      }),
      waiverUsed: false,
    });
    expect(result).toEqual({ ok: false, reason: 'release-hash-mismatch' });
    expect(await releaseDocStore.findByArtifact('artifact-1')).toBeNull();
    // No approval signature was emitted.
    expect(events).toHaveLength(0);
  });
});
