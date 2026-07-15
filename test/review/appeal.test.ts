/**
 * The appeal stage (#47, SPEC §4: "Appeals → a second reviewer, never the
 * original") and the human lane's appeal-reviewer ≠ original-reviewer rule.
 *
 * These exercise the stage and lane directly (not over HTTP) so the second-
 * reviewer routing can be forced with minimal stores:
 *
 *  - only a `rejected` artifact is appealable;
 *  - an appeal opens a new `isAppeal` case carrying the original report, excluding
 *    the human reviewer who rejected it (or nobody, for an automated rejection),
 *    and moves the artifact back to `reviewing`;
 *  - the lane then refuses a verdict from the excluded reviewer and accepts one
 *    from a second reviewer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import type { AuditEvent } from '../../src/audit/index.js';
import { noopAuditSink, setAuditSink } from '../../src/audit/index.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import { composeOidcIdentity } from '../../src/publisher/types.js';
import { createAppealStage } from '../../src/review/appeal.js';
import type { AutomatedReviewReport } from '../../src/review/report.js';
import { InMemoryReviewCaseStore } from '../../src/review/store.js';
import { createHumanReviewLane } from '../../src/review/human/lane.js';

const ISSUER = 'https://issuer.example';
const report: AutomatedReviewReport = {
  checksModule: '@gridmason/cli/checks',
  checksVersion: '0.0.3',
  status: 'fail',
  results: [
    { id: 'sdk.raw-network', status: 'fail', message: 'raw fetch() outside the SDK' },
    { id: 'manifest.schema', status: 'pass', message: 'ok' },
  ],
};

interface Stores {
  artifactStore: InMemoryArtifactStore;
  reviewCaseStore: InMemoryReviewCaseStore;
  publisherStore: InMemoryPublisherStore;
}

function stores(): Stores {
  return {
    artifactStore: new InMemoryArtifactStore(),
    reviewCaseStore: new InMemoryReviewCaseStore(),
    publisherStore: new InMemoryPublisherStore(),
  };
}

/** Create an artifact for `publisherId` and drive it to the given lifecycle state. */
async function seedArtifact(
  { artifactStore }: Stores,
  publisherId: string,
  state: 'submitted' | 'reviewing' | 'rejected',
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
  const id = created.record.id;
  if (state === 'reviewing' || state === 'rejected') {
    await artifactStore.transition(id, 'submitted', 'reviewing');
  }
  if (state === 'rejected') {
    await artifactStore.transition(id, 'reviewing', 'rejected');
  }
  return id;
}

describe('appeal stage', () => {
  let audit: AuditEvent[];

  beforeEach(() => {
    audit = [];
    setAuditSink({ emit: (event) => audit.push(event) });
  });
  afterEach(() => setAuditSink(noopAuditSink));

  it('refuses to appeal an artifact that is not rejected', async () => {
    const s = stores();
    const id = await seedArtifact(s, 'pub-1', 'reviewing');
    await s.reviewCaseStore.create({ artifactId: id, checksReport: report });
    const artifact = (await s.artifactStore.findById(id))!;

    const stage = createAppealStage(s);
    const result = await stage.appeal(artifact, 'pub-1-actor');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection.kind).toBe('not-appealable');
    // A refused appeal is not a state transition, so no `artifact.appeal` event.
    expect(audit.some((e) => e.action === 'artifact.appeal')).toBe(false);
  });

  it('fails closed when a rejected artifact has no review case', async () => {
    const s = stores();
    const id = await seedArtifact(s, 'pub-1', 'rejected');
    const artifact = (await s.artifactStore.findById(id))!;

    const result = await createAppealStage(s).appeal(artifact, 'pub-1-actor');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection.kind).toBe('no-review-case');
  });

  it('re-opens an automated rejection with no excluded reviewer', async () => {
    const s = stores();
    const id = await seedArtifact(s, 'pub-1', 'rejected');
    // The automated stage opens a case but records no human verdict.
    await s.reviewCaseStore.create({ artifactId: id, checksReport: report });
    const artifact = (await s.artifactStore.findById(id))!;

    const result = await createAppealStage(s).appeal(artifact, 'pub-1-actor');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.outcome.artifact.state).toBe('reviewing');
    expect(result.outcome.excludedReviewer).toBeNull();
    // A fresh appeal case carrying the original report, marked as an appeal.
    expect(result.outcome.reviewCase.isAppeal).toBe(true);
    expect(result.outcome.reviewCase.excludedReviewer).toBeNull();
    expect(result.outcome.reviewCase.checksReport.results).toEqual(report.results);
    // The re-open transition is audited under the appealing publisher.
    expect(audit).toContainEqual(
      expect.objectContaining({ actor: 'pub-1-actor', action: 'artifact.appeal', subject: id }),
    );
  });

  it('re-opens a human rejection excluding the original reviewer', async () => {
    const s = stores();
    const id = await seedArtifact(s, 'pub-1', 'rejected');
    const original = composeOidcIdentity(ISSUER, 'reviewer-1');
    const opened = await s.reviewCaseStore.create({ artifactId: id, checksReport: report });
    await s.reviewCaseStore.recordVerdict({
      caseId: opened.id,
      reviewer: original,
      verdict: 'rejected',
      findings: [{ checkId: 'sdk.raw-network', detail: 'reaches the network raw' }],
      waiverUsed: false,
    });
    const artifact = (await s.artifactStore.findById(id))!;

    const result = await createAppealStage(s).appeal(artifact, 'pub-1-actor');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.outcome.excludedReviewer).toBe(original);
    expect(result.outcome.reviewCase.excludedReviewer).toBe(original);
    // The newest case (the appeal) is what the queue surfaces.
    const latest = await s.reviewCaseStore.findByArtifact(id);
    expect(latest?.id).toBe(result.outcome.reviewCase.id);
    expect(latest?.verdict).toBeNull();
  });

  it('surfaces a transition-failed fault when the artifact left rejected concurrently', async () => {
    const s = stores();
    // The store holds the artifact in `reviewing`, but a stale `rejected` record
    // is passed in — the guarded transition then finds no `rejected` row to move.
    const id = await seedArtifact(s, 'pub-1', 'reviewing');
    await s.reviewCaseStore.create({ artifactId: id, checksReport: report });
    const stale = { ...(await s.artifactStore.findById(id))!, state: 'rejected' as const };

    const result = await createAppealStage(s).appeal(stale, 'pub-1-actor');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection.kind).toBe('transition-failed');
  });
});

describe('human lane: appeal reviewer ≠ original reviewer', () => {
  beforeEach(() => setAuditSink({ emit: () => {} }));
  afterEach(() => setAuditSink(noopAuditSink));

  it('refuses a verdict from the excluded reviewer and accepts a second reviewer', async () => {
    const s = stores();
    // The author is a distinct identity, so reviewer≠author never interferes.
    const authorReg = await s.publisherStore.register({
      issuer: ISSUER,
      subject: 'author-1',
      prefix: 'acme',
      tier: 'verified',
    });
    if (!authorReg.ok) throw new Error('author register failed');
    const id = await seedArtifact(s, authorReg.record.id, 'reviewing');
    const original = composeOidcIdentity(ISSUER, 'reviewer-1');
    const appealCase = await s.reviewCaseStore.create({
      artifactId: id,
      checksReport: report,
      isAppeal: true,
      excludedReviewer: original,
    });

    const lane = createHumanReviewLane({
      artifactStore: s.artifactStore,
      reviewCaseStore: s.reviewCaseStore,
      publisherStore: s.publisherStore,
      selfReviewWaiver: false,
    });

    // The original reviewer cannot decide the appeal.
    const refused = await lane.submitVerdict({
      caseId: appealCase.id,
      reviewer: { issuer: ISSUER, subject: 'reviewer-1' },
      decision: 'approve',
      findings: [],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.rejection.kind).toBe('appeal-original-reviewer');

    // A second reviewer may.
    const accepted = await lane.submitVerdict({
      caseId: appealCase.id,
      reviewer: { issuer: ISSUER, subject: 'reviewer-2' },
      decision: 'approve',
      findings: [],
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('unreachable');
    expect(accepted.outcome.artifact.state).toBe('approved');
  });
});
