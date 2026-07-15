/**
 * Human review lane → countersign integration (#9 → #10): the countersign +
 * transparency-logging stage runs on the `reviewing → approved` transition and
 * only then. An approval publishes a release document with a verifiable envelope;
 * a rejection never reaches the stage, so a rejected artifact is never
 * countersigned (the acceptance's negative).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryArtifactStore, type ArtifactStore } from '../../src/artifact/store.js';
import { noopAuditSink, setAuditSink, type AuditEvent } from '../../src/audit/index.js';
import { loadCountersignIdentity } from '../../src/countersign/identity.js';
import { createCountersignStage } from '../../src/countersign/stage.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import type { AutomatedReviewReport } from '../../src/review/report.js';
import { InMemoryReviewCaseStore } from '../../src/review/store.js';
import { createHumanReviewLane, type VerdictOutcome } from '../../src/review/human/lane.js';
import { InMemoryReleaseDocStore } from '../../src/release/store.js';
import { InMemoryTransparencyLog } from '../../src/sigstore/log.js';
import { makeCountersignFixture, makePublisherFixture } from './fixtures/envelope.js';

const ISSUER = 'https://accounts.example.com';
const report: AutomatedReviewReport = {
  checksModule: '@gridmason/cli/checks',
  checksVersion: '0.6.0',
  status: 'pass',
  results: [{ id: 'manifest.schema', status: 'pass', message: 'ok' }],
};

async function harness() {
  const publisher = await makePublisherFixture({ issuer: ISSUER });
  const artifactStore: ArtifactStore = new InMemoryArtifactStore();
  const reviewCaseStore = new InMemoryReviewCaseStore();
  const publisherStore = new InMemoryPublisherStore();
  const releaseDocStore = new InMemoryReleaseDocStore();

  await publisherStore.register({ issuer: ISSUER, subject: 'author-1', prefix: 'acme', tier: 'operator' });
  const author = await publisherStore.findByIdentity(ISSUER, 'author-1');

  const created = await artifactStore.create({
    publisherId: author!.id,
    tag: 'acme-clock',
    version: '1.2.0',
    contentHashes: publisher.files,
    sourceArchiveRef: null,
    envelope: publisher.publisherEnvelope,
  });
  if (!created.ok) throw new Error('seed failed');
  await artifactStore.transition(created.record.id, 'submitted', 'reviewing');
  const reviewCase = await reviewCaseStore.create({ artifactId: created.record.id, checksReport: report });

  const identity = loadCountersignIdentity(makeCountersignFixture())!;
  const stage = createCountersignStage({
    identity,
    transparencyLog: new InMemoryTransparencyLog('registry.test'),
    releaseDocStore,
  });
  const lane = createHumanReviewLane({
    artifactStore,
    reviewCaseStore,
    publisherStore,
    selfReviewWaiver: false,
    onApprove: async (outcome: VerdictOutcome) => {
      await stage.run({ artifact: outcome.artifact, waiverUsed: outcome.waiverUsed });
    },
  });
  return { lane, releaseDocStore, artifactId: created.record.id, caseId: reviewCase.id };
}

describe('review lane → countersign', () => {
  let events: AuditEvent[];
  beforeEach(() => {
    events = [];
    setAuditSink({ emit: (e) => events.push(e) });
  });
  afterEach(() => setAuditSink(noopAuditSink));

  it('countersigns and emits a release doc on approval', async () => {
    const { lane, releaseDocStore, artifactId, caseId } = await harness();

    const result = await lane.submitVerdict({
      caseId,
      reviewer: { issuer: ISSUER, subject: 'reviewer-1' },
      decision: 'approve',
      findings: [],
    });
    expect(result.ok).toBe(true);

    const stored = await releaseDocStore.findByArtifact(artifactId);
    expect(stored).not.toBeNull();
    expect(stored!.envelope.registrySig).toBeDefined();
    expect(events.map((e) => e.action)).toContain('release.countersigned');
    expect(events.map((e) => e.action)).toContain('release.logged');
  });

  it('never countersigns a rejected artifact', async () => {
    const { lane, releaseDocStore, artifactId, caseId } = await harness();

    const result = await lane.submitVerdict({
      caseId,
      reviewer: { issuer: ISSUER, subject: 'reviewer-1' },
      decision: 'reject',
      findings: [],
    });
    expect(result.ok).toBe(true);

    expect(await releaseDocStore.findByArtifact(artifactId)).toBeNull();
    expect(events.map((e) => e.action)).not.toContain('release.countersigned');
    expect(events.map((e) => e.action)).not.toContain('release.logged');
  });
});
