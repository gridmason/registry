/**
 * Transparency-log append retry + recovery (#38).
 *
 * The countersign stage retries a failing `transparencyLog.append` with bounded
 * backoff, and on final failure records an audited `release.log_failed` event while
 * leaving the artifact approved-but-unpublished (no release doc). The re-drive
 * service completes that artifact once the log recovers — an idempotent re-run of
 * the same stage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import type { ArtifactRecord } from '../../src/artifact/types.js';
import { noopAuditSink, setAuditSink, type AuditEvent } from '../../src/audit/index.js';
import { loadCountersignIdentity } from '../../src/countersign/identity.js';
import { createReleaseRedriveService } from '../../src/countersign/redrive.js';
import { createCountersignStage } from '../../src/countersign/stage.js';
import { InMemoryReleaseDocStore } from '../../src/release/store.js';
import { InMemoryReviewCaseStore } from '../../src/review/store.js';
import type { AutomatedReviewReport } from '../../src/review/report.js';
import type { LogAppendInput, LogAppendResult, TransparencyLog } from '../../src/sigstore/log.js';
import { InMemoryTransparencyLog } from '../../src/sigstore/log.js';
import { makeCountersignFixture, makePublisherFixture } from './fixtures/envelope.js';

const PASS_REPORT: AutomatedReviewReport = {
  checksModule: '@gridmason/cli/checks',
  checksVersion: '0.0.3',
  status: 'pass',
  results: [{ id: 'manifest.schema', status: 'pass', message: 'ok' }],
};

/** A transparency log that throws for the first `failures` appends, then delegates. */
class FlakyLog implements TransparencyLog {
  private calls = 0;
  private readonly inner = new InMemoryTransparencyLog('registry.test');
  constructor(private readonly failures: number) {}
  get attempts(): number {
    return this.calls;
  }
  append(input: LogAppendInput): Promise<LogAppendResult> {
    this.calls += 1;
    if (this.calls <= this.failures) {
      return Promise.reject(new Error(`rekor unavailable (attempt ${this.calls})`));
    }
    return this.inner.append(input);
  }
}

function artifactRecord(
  overrides: Partial<ArtifactRecord> & Pick<ArtifactRecord, 'envelope' | 'contentHashes'>,
): ArtifactRecord {
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

describe('transparency-log append retry (#38)', () => {
  let events: AuditEvent[];
  beforeEach(() => {
    events = [];
    setAuditSink({ emit: (e) => events.push(e) });
  });
  afterEach(() => setAuditSink(noopAuditSink));

  const identity = () => loadCountersignIdentity(makeCountersignFixture())!;

  it('recovers when the log fails N times then succeeds (within the attempt budget)', async () => {
    const publisher = await makePublisherFixture();
    const log = new FlakyLog(2); // fails twice, succeeds on the 3rd attempt
    const releaseDocStore = new InMemoryReleaseDocStore();
    const stage = createCountersignStage({
      identity: identity(),
      transparencyLog: log,
      releaseDocStore,
      logAppendRetry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    const result = await stage.run({
      artifact: artifactRecord({ envelope: publisher.publisherEnvelope, contentHashes: publisher.files }),
      waiverUsed: false,
    });

    expect(result.ok).toBe(true);
    expect(log.attempts).toBe(3);
    expect(await releaseDocStore.findByArtifact('artifact-1')).not.toBeNull();
    const actions = events.map((e) => e.action);
    expect(actions).toContain('release.countersigned');
    expect(actions).toContain('release.logged');
    expect(actions).not.toContain('release.log_failed');
  });

  it('gives up after the attempt budget: audits release.log_failed, publishes no release', async () => {
    const publisher = await makePublisherFixture();
    const log = new FlakyLog(5); // always fails within a 3-attempt budget
    const releaseDocStore = new InMemoryReleaseDocStore();
    const stage = createCountersignStage({
      identity: identity(),
      transparencyLog: log,
      releaseDocStore,
      logAppendRetry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    const result = await stage.run({
      artifact: artifactRecord({ envelope: publisher.publisherEnvelope, contentHashes: publisher.files }),
      waiverUsed: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('log-append-failed');
    expect(log.attempts).toBe(3); // exhausted the budget
    // Approved-but-unpublished: no release doc, but the failure is audited (not silent).
    expect(await releaseDocStore.findByArtifact('artifact-1')).toBeNull();
    const actions = events.map((e) => e.action);
    expect(actions).toContain('release.countersigned'); // signing happened
    expect(actions).toContain('release.log_failed');
    expect(actions).not.toContain('release.logged');
  });

  it('audits release.persist_failed when the release doc cannot be persisted', async () => {
    const publisher = await makePublisherFixture();
    // A release-doc store whose create always fails: the signature + log entry
    // exist, but persistence does not, so the artifact is approved-unpublished.
    const releaseDocStore = new InMemoryReleaseDocStore();
    releaseDocStore.create = () => Promise.reject(new Error('db down'));
    const stage = createCountersignStage({
      identity: identity(),
      transparencyLog: new InMemoryTransparencyLog('registry.test'),
      releaseDocStore,
      logAppendRetry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    const result = await stage.run({
      artifact: artifactRecord({ envelope: publisher.publisherEnvelope, contentHashes: publisher.files }),
      waiverUsed: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('persist-failed');
    const actions = events.map((e) => e.action);
    // The signing act and the log anchoring both happened and are audited; only
    // persistence failed, and that failure is now audited too (no silent gap).
    expect(actions).toContain('release.countersigned');
    expect(actions).toContain('release.persist_failed');
    expect(actions).not.toContain('release.logged');
  });

  it('re-drives an approved-unpublished artifact to completion once the log recovers', async () => {
    const publisher = await makePublisherFixture({ artifactId: 'acme-clock@1.2.0' });
    const artifactStore = new InMemoryArtifactStore();
    const reviewCaseStore = new InMemoryReviewCaseStore();
    const releaseDocStore = new InMemoryReleaseDocStore();
    const log = new FlakyLog(3); // fails the initial 3-attempt run entirely, then recovers

    const created = await artifactStore.create({
      publisherId: 'pub-1',
      tag: 'acme-clock',
      version: '1.2.0',
      contentHashes: publisher.files,
      sourceArchiveRef: null,
      envelope: publisher.publisherEnvelope,
    });
    if (!created.ok) throw new Error('seed failed');
    await artifactStore.transition(created.record.id, 'submitted', 'approved');
    const reviewCase = await reviewCaseStore.create({ artifactId: created.record.id, checksReport: PASS_REPORT });
    await reviewCaseStore.recordVerdict({
      caseId: reviewCase.id,
      reviewer: 'rev-1',
      verdict: 'approved',
      findings: [],
      waiverUsed: false,
    });

    const stage = createCountersignStage({
      identity: identity(),
      transparencyLog: log,
      releaseDocStore,
      logAppendRetry: { maxAttempts: 3, baseDelayMs: 0 },
    });
    const redrive = createReleaseRedriveService({ artifactStore, releaseDocStore, reviewCaseStore, stage });

    // First run failed (the 3 attempts all threw): approved-unpublished.
    const firstRun = await stage.run({ artifact: created.record, waiverUsed: false });
    expect(firstRun.ok).toBe(false);
    expect(await releaseDocStore.findByArtifact(created.record.id)).toBeNull();

    // The log has recovered (attempt 4+ succeeds); re-drive completes the release.
    const result = await redrive.redrive(created.record.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.ok).toBe(true);
    expect(await releaseDocStore.findByArtifact(created.record.id)).not.toBeNull();

    // Re-driving again is an idempotent no-op — the artifact already has a release.
    const again = await redrive.redrive(created.record.id);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.rejection).toBe('already-released');
  });
});
