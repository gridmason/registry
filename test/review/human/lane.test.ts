/**
 * Human review lane fail-closed paths (#9). These exercise the lane directly
 * (not over HTTP) so an integrity fault can be forced with minimal stores:
 *
 *  - the artifact's publisher record cannot be resolved → the verdict is refused
 *    (reviewer≠author cannot be proven, so never let the identity through);
 *  - the artifact leaves `reviewing` before the state moves → the null transition
 *    is surfaced as a fault, not reported as success with a fabricated state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryArtifactStore, type ArtifactStore } from '../../../src/artifact/store.js';
import type { ArtifactRecord } from '../../../src/artifact/types.js';
import type { AuditEvent } from '../../../src/audit/index.js';
import { noopAuditSink, setAuditSink } from '../../../src/audit/index.js';
import { InMemoryPublisherStore } from '../../../src/publisher/store.js';
import type { AutomatedReviewReport } from '../../../src/review/report.js';
import { InMemoryReviewCaseStore } from '../../../src/review/store.js';
import { createHumanReviewLane } from '../../../src/review/human/lane.js';

const ISSUER = 'https://issuer.example';
const report: AutomatedReviewReport = {
  checksModule: '@gridmason/cli/checks',
  checksVersion: '0.0.3',
  status: 'pass',
  results: [{ id: 'manifest.schema', status: 'pass', message: 'ok' }],
};

/** Put a fresh artifact into `reviewing` with an open review case, and return both. */
async function seedReviewing(
  artifactStore: ArtifactStore,
  reviewCaseStore: InMemoryReviewCaseStore,
  publisherId: string,
) {
  const created = await artifactStore.create({
    publisherId,
    tag: 'acme-clock',
    version: '1.0.0',
    contentHashes: {},
    sourceArchiveRef: null,
    envelope: {},
  });
  if (!created.ok) throw new Error('seed failed');
  await artifactStore.transition(created.record.id, 'submitted', 'reviewing');
  const reviewCase = await reviewCaseStore.create({
    artifactId: created.record.id,
    checksReport: report,
  });
  return { artifactId: created.record.id, caseId: reviewCase.id };
}

describe('human review lane fail-closed paths', () => {
  let audit: AuditEvent[];

  beforeEach(() => {
    audit = [];
    setAuditSink({ emit: (event) => audit.push(event) });
  });

  afterEach(() => {
    setAuditSink(noopAuditSink);
  });

  it('refuses the verdict when the artifact publisher cannot be resolved', async () => {
    const artifactStore = new InMemoryArtifactStore();
    const reviewCaseStore = new InMemoryReviewCaseStore();
    // The publisher store is empty, so the artifact's publisherId resolves to null.
    const publisherStore = new InMemoryPublisherStore();
    const { artifactId, caseId } = await seedReviewing(artifactStore, reviewCaseStore, 'ghost-pub');

    const lane = createHumanReviewLane({
      artifactStore,
      reviewCaseStore,
      publisherStore,
      selfReviewWaiver: false,
    });
    const result = await lane.submitVerdict({
      caseId,
      reviewer: { issuer: ISSUER, subject: 'reviewer-1' },
      decision: 'approve',
      findings: [],
    });

    expect(result).toEqual({ ok: false, rejection: { kind: 'author-unresolved' } });
    // Nothing moved and nothing was recorded/audited.
    expect((await artifactStore.findById(artifactId))?.state).toBe('reviewing');
    expect((await reviewCaseStore.findById(caseId))?.verdict).toBeNull();
    expect(audit).toHaveLength(0);
  });

  it('surfaces a null transition as a fault instead of a fabricated success', async () => {
    const reviewCaseStore = new InMemoryReviewCaseStore();
    const publisherStore = new InMemoryPublisherStore();
    await publisherStore.register({
      issuer: ISSUER,
      subject: 'author-1',
      prefix: 'acme',
      tier: 'operator',
    });
    const author = await publisherStore.findByIdentity(ISSUER, 'author-1');

    // A real in-memory store seeds the state; a wrapper forces transition to fail
    // (as a concurrent revoke/kill would) while every read still reports `reviewing`.
    const backing = new InMemoryArtifactStore();
    const artifactStore: ArtifactStore = {
      create: (input) => backing.create(input),
      findById: (id) => backing.findById(id),
      findByVersion: (p, t, v) => backing.findByVersion(p, t, v),
      listByState: (s) => backing.listByState(s),
      transition: (): Promise<ArtifactRecord | null> => Promise.resolve(null),
    };
    const { artifactId, caseId } = await seedReviewing(backing, reviewCaseStore, author!.id);

    const lane = createHumanReviewLane({
      artifactStore,
      reviewCaseStore,
      publisherStore,
      selfReviewWaiver: false,
    });
    const result = await lane.submitVerdict({
      caseId,
      reviewer: { issuer: ISSUER, subject: 'reviewer-1' },
      decision: 'approve',
      findings: [{ checkId: 'manifest.schema', detail: 'clean' }],
    });

    expect(result).toEqual({ ok: false, rejection: { kind: 'transition-failed' } });
    // The verdict was recorded (it won the case) but no transition audit was emitted,
    // so nobody is told the artifact moved when it did not.
    expect((await backing.findById(artifactId))?.state).toBe('reviewing');
    expect(audit.map((e) => e.action)).not.toContain('review.approved');
  });
});
