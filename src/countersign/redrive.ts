/**
 * Release re-drive (#38) — recover an approved-but-unpublished artifact.
 *
 * The countersign stage records its own faults and never unwinds the committed
 * approval, so a transparency-log outage can leave an artifact `approved` with no
 * release document (approved-unpublished). That is deliberate — the verdict stands
 * — but the release still has to land once the log recovers. This service re-runs
 * the existing {@link CountersignStage} for exactly those artifacts:
 *
 *  - the artifact must be `approved` (a rejected/revoked/killed artifact is never
 *    re-driven);
 *  - it must **lack** a release document — an artifact that already has one is
 *    complete, so re-drive is an idempotent no-op (safe to call repeatedly, and
 *    safe against a racing approval that just published it);
 *  - the waiver flag is recovered from the artifact's review case so the re-driven
 *    release carries the same SPEC §4a disclosure the original approval would have.
 *
 * It reuses `stage.run` unchanged (same countersign → append-with-retry → persist →
 * audit path), so a re-drive is indistinguishable from the original approval-time
 * run — including the retry/backoff and the audited `release.log_failed` on a still-
 * failing log.
 */
import type { ArtifactStore } from '../artifact/store.js';
import type { ReleaseDocStore } from '../release/store.js';
import type { ReviewCaseStore } from '../review/store.js';
import type { CountersignResult, CountersignStage } from './stage.js';

/** Why a re-drive did not run the stage. The route maps each to a response. */
export type RedriveRejection =
  | 'not-found'
  | 'not-approved'
  | 'already-released'
  | 'review-case-missing';

export type RedriveResult =
  | { readonly ok: true; readonly result: CountersignResult }
  | { readonly ok: false; readonly rejection: RedriveRejection };

export interface ReleaseRedriveService {
  /** Re-run the countersign stage for an approved artifact lacking a release doc. */
  redrive(artifactId: string): Promise<RedriveResult>;
}

export interface ReleaseRedriveDeps {
  readonly artifactStore: ArtifactStore;
  readonly releaseDocStore: ReleaseDocStore;
  readonly reviewCaseStore: ReviewCaseStore;
  readonly stage: CountersignStage;
}

export function createReleaseRedriveService(deps: ReleaseRedriveDeps): ReleaseRedriveService {
  const { artifactStore, releaseDocStore, reviewCaseStore, stage } = deps;

  return {
    async redrive(artifactId) {
      const artifact = await artifactStore.findById(artifactId);
      if (!artifact) return { ok: false, rejection: 'not-found' };
      // Only an `approved` artifact is re-drivable: it is the one state that can
      // legitimately lack a release doc (the countersign stage runs on approval).
      if (artifact.state !== 'approved') return { ok: false, rejection: 'not-approved' };

      // Idempotency: an artifact that already has a release doc is complete.
      const existing = await releaseDocStore.findByArtifact(artifactId);
      if (existing) return { ok: false, rejection: 'already-released' };

      // Recover the waiver flag so the re-driven release carries the same SPEC §4a
      // disclosure the original approval would have. An approved artifact always
      // has a decided review case (FK + the approval flow); a missing one is an
      // integrity fault, not a normal path — fail closed rather than guess `false`
      // and risk mislabeling a waiver release.
      const reviewCase = await reviewCaseStore.findByArtifact(artifactId);
      if (!reviewCase) return { ok: false, rejection: 'review-case-missing' };

      const result = await stage.run({ artifact, waiverUsed: reviewCase.waiverUsed });
      return { ok: true, result };
    },
  };
}
