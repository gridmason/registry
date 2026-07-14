/**
 * The automated-review stage (#8): persist the checks report, transition the
 * artifact, and audit the transition. Exercised over in-memory stores and a fake
 * audit sink (the established test seam), no live database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import type { ArtifactRecord } from '../../src/artifact/types.js';
import type { ArtifactFile } from '../../src/artifact/upload.js';
import type { AuditEvent } from '../../src/audit/index.js';
import { noopAuditSink, setAuditSink } from '../../src/audit/index.js';
import { createAutomatedReviewStage } from '../../src/review/automated.js';
import { InMemoryReviewCaseStore } from '../../src/review/store.js';
import { circularRequiresFixture, cleanFixture, filesForFixture } from './fixtures.js';

describe('automated review stage', () => {
  let artifactStore: InMemoryArtifactStore;
  let reviewCaseStore: InMemoryReviewCaseStore;
  let stage: ReturnType<typeof createAutomatedReviewStage>;
  let audit: AuditEvent[];

  async function submit(): Promise<ArtifactRecord> {
    const created = await artifactStore.create({
      publisherId: 'pub-1',
      tag: 'acme-clock',
      version: '1.2.0',
      contentHashes: {},
      sourceArchiveRef: null,
      envelope: {},
    });
    if (!created.ok) throw new Error('fixture artifact failed to insert');
    return created.record;
  }

  beforeEach(() => {
    artifactStore = new InMemoryArtifactStore();
    reviewCaseStore = new InMemoryReviewCaseStore();
    stage = createAutomatedReviewStage({ artifactStore, reviewCaseStore });
    audit = [];
    setAuditSink({ emit: (event) => audit.push(event) });
  });

  afterEach(() => {
    setAuditSink(noopAuditSink);
  });

  it('moves a clean artifact submitted → reviewing, persists a passing report, and audits it', async () => {
    const artifact = await submit();

    const outcome = await stage.review(artifact, filesForFixture(cleanFixture));

    expect(outcome.artifact.state).toBe('reviewing');
    expect(outcome.report.status).toBe('pass');
    expect((await artifactStore.findById(artifact.id))?.state).toBe('reviewing');

    const persisted = await reviewCaseStore.findByArtifact(artifact.id);
    expect(persisted?.checksReport).toEqual(outcome.report);

    expect(audit).toEqual([
      expect.objectContaining({
        actor: 'system',
        action: 'review.reviewing',
        subject: artifact.id,
      }),
    ]);
  });

  it('rejects a circular-requires artifact (submitted → rejected) and audits the rejection', async () => {
    const artifact = await submit();

    const outcome = await stage.review(artifact, filesForFixture(circularRequiresFixture));

    expect(outcome.artifact.state).toBe('rejected');
    expect(outcome.report.status).toBe('fail');
    expect(outcome.report.results).toContainEqual(
      expect.objectContaining({ id: 'deps.acyclic', status: 'fail' }),
    );
    expect((await artifactStore.findById(artifact.id))?.state).toBe('rejected');

    const persisted = await reviewCaseStore.findByArtifact(artifact.id);
    expect(persisted?.checksReport.status).toBe('fail');

    expect(audit).toEqual([
      expect.objectContaining({ action: 'review.rejected', subject: artifact.id }),
    ]);
  });

  it('rejects an artifact whose manifest is not valid JSON as a load failure', async () => {
    const artifact = await submit();
    const files: ArtifactFile[] = [
      { path: 'manifest.json', role: 'manifest', bytes: new Uint8Array(Buffer.from('not json{', 'utf8')) },
      { path: 'entry.js', role: 'entry', bytes: new Uint8Array(Buffer.from('export default 1', 'utf8')) },
    ];

    const outcome = await stage.review(artifact, files);

    expect(outcome.artifact.state).toBe('rejected');
    expect(outcome.report.status).toBe('fail');
    expect(outcome.report.error?.code).toBe('invalid-json');
    expect(outcome.report.results).toEqual([]);
  });
});
