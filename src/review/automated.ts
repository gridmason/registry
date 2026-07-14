/**
 * Automated-review stage (FR-3; SPEC §4, §7, §9).
 *
 * Runs immediately after a successful upload intake: it runs the **shared**
 * `@gridmason/cli/checks` module over the uploaded artifact (manifest lint incl.
 * the publisher-prefix check, SDK-adherence, and dependency-DAG acyclicity —
 * circular `requires` is rejected, SPEC §7), persists the produced report against
 * a {@link ReviewCaseRecord}, and advances the artifact's lifecycle:
 *
 *  - a clean run → `submitted → reviewing` (handed to the human review lane, next
 *    issue);
 *  - a hard failure (any check failed, or the manifest could not be loaded) →
 *    `submitted → rejected`.
 *
 * Each transition emits an {@link emitAuditEvent} (SPEC §10, FR-12). The stage is
 * **deterministic** — it reimplements no check (the report is verbatim shared-
 * checks output) — so its verdict on an artifact matches a local `gridmason lint`
 * of the same manifest by construction (SPEC §9).
 */
import type { ArtifactStore } from '../artifact/store.js';
import type { ArtifactRecord, ArtifactState } from '../artifact/types.js';
import type { ArtifactFile } from '../artifact/upload.js';
import { emitAuditEvent } from '../audit/index.js';
import { buildAutomatedReviewReport, type AutomatedReviewReport } from './report.js';
import type { ReviewCaseStore } from './store.js';

/**
 * The registry itself performs the automated review, so its transitions are
 * attributed to `system` rather than to the publishing identity (which is only
 * the actor of the publish intake that preceded it).
 */
const SYSTEM_ACTOR = 'system';

export interface AutomatedReviewOutcome {
  /** The artifact after its review transition (`reviewing` or `rejected`). */
  readonly artifact: ArtifactRecord;
  /** The report persisted on the review case. */
  readonly report: AutomatedReviewReport;
}

export interface AutomatedReviewStage {
  /**
   * Review a freshly-submitted artifact against the shared checks, persist the
   * report, transition the artifact, and audit the transition. `files` are the
   * parsed upload parts (with roles + bytes) so the manifest and served source
   * are read without a round-trip to the object store.
   */
  review(
    artifact: ArtifactRecord,
    files: readonly ArtifactFile[],
  ): Promise<AutomatedReviewOutcome>;
}

export interface AutomatedReviewDeps {
  readonly artifactStore: ArtifactStore;
  readonly reviewCaseStore: ReviewCaseStore;
}

export function createAutomatedReviewStage(
  deps: AutomatedReviewDeps,
): AutomatedReviewStage {
  const { artifactStore, reviewCaseStore } = deps;
  return {
    async review(artifact, files) {
      const report = buildAutomatedReviewReport(files);
      // Persist the report first so a review case always carries its checks
      // report even if the transition below races with a concurrent one.
      await reviewCaseStore.create({ artifactId: artifact.id, checksReport: report });

      const target: ArtifactState = report.status === 'fail' ? 'rejected' : 'reviewing';
      const moved = await artifactStore.transition(artifact.id, 'submitted', target);
      // A null transition means the artifact was no longer `submitted` (already
      // reviewed): do not re-emit a transition event for a move that did not happen.
      if (moved) {
        emitAuditEvent(SYSTEM_ACTOR, `review.${target}`, artifact.id);
      }
      return { artifact: moved ?? artifact, report };
    },
  };
}
