/**
 * The appeal stage — route a rejected artifact to a second reviewer (SPEC §4:
 * "Appeals → a second reviewer (never the original)").
 *
 * A publisher appeals a rejected submission through the publisher-facing
 * `POST /v1/artifacts/:id/appeal` endpoint. The stage re-opens the artifact for
 * human review without letting the original reviewer decide it again:
 *
 *  1. Only a `rejected` artifact is appealable — anything else is refused
 *     (`not-appealable`), matching the CLI's forward contract (`409 not_appealable`).
 *  2. It reads the artifact's most recent review case (the rejection) to recover
 *     the automated `checksReport` (so the second reviewer's findings still map to
 *     the same check ids) and the identity of the reviewer who rejected it.
 *  3. It opens a **new** review case marked `isAppeal` with that reviewer recorded
 *     as `excludedReviewer` — because {@link ReviewCaseStore.recordVerdict} is
 *     single-shot, the rejected case can never be re-decided, so a fresh undecided
 *     case is the only way back into the queue. When the original rejection was
 *     the automated stage's (`system`, no human reviewer), there is nobody to
 *     exclude and `excludedReviewer` is `null`.
 *  4. It transitions the artifact `rejected → reviewing` via the guarded
 *     {@link ArtifactStore.transition}, so the human lane's queue picks the appeal
 *     case up (its `findByArtifact` returns the newest case).
 *
 * The appeal reviewer ≠ original reviewer rule is *enforced* later, when a verdict
 * is submitted, by the human lane reading the case's `excludedReviewer` — the same
 * seam as reviewer ≠ author. This stage only routes the second review.
 *
 * The case is opened **before** the transition, mirroring the automated stage: a
 * `null` transition (the artifact left `rejected` concurrently — a revoke/kill)
 * leaves an inert undecided case that the queue never surfaces (it only lists
 * `reviewing` artifacts), rather than moving the artifact to `reviewing` with no
 * case for it. The stage never re-implements a check; it reuses the persisted
 * report verbatim.
 */
import type { ArtifactRecord } from '../artifact/types.js';
import type { ArtifactStore } from '../artifact/store.js';
import { emitAuditEvent } from '../audit/index.js';
import type { ReviewCaseRecord, ReviewCaseStore } from './store.js';

/** Why an appeal was refused. The route maps each to an HTTP response. */
export type AppealRejection =
  | { readonly kind: 'not-appealable' }
  | { readonly kind: 'no-review-case' }
  | { readonly kind: 'transition-failed' };

export interface AppealOutcome {
  /** The artifact after re-opening (`reviewing`). */
  readonly artifact: ArtifactRecord;
  /** The new appeal review case handed to the second reviewer. */
  readonly reviewCase: ReviewCaseRecord;
  /** The original reviewer this appeal excludes, or `null` (automated rejection). */
  readonly excludedReviewer: string | null;
}

export type AppealResult =
  | { readonly ok: true; readonly outcome: AppealOutcome }
  | { readonly ok: false; readonly rejection: AppealRejection };

export interface AppealStageDeps {
  readonly artifactStore: ArtifactStore;
  readonly reviewCaseStore: ReviewCaseStore;
}

export interface AppealStage {
  /**
   * Re-open a rejected artifact for a second review. `actor` is the publisher
   * identity (composite) initiating the appeal, recorded on the audit event.
   */
  appeal(artifact: ArtifactRecord, actor: string): Promise<AppealResult>;
}

export function createAppealStage(deps: AppealStageDeps): AppealStage {
  const { artifactStore, reviewCaseStore } = deps;
  return {
    async appeal(artifact, actor) {
      // Only a rejected submission can be appealed (CLI contract: 409 not_appealable).
      if (artifact.state !== 'rejected') {
        return { ok: false, rejection: { kind: 'not-appealable' } };
      }

      // The rejection's review case carries the report the second reviewer needs
      // and the reviewer to exclude. A rejected artifact always has one; its
      // absence is an integrity fault, so fail closed rather than re-open with no
      // report to map findings against.
      const prior = await reviewCaseStore.findByArtifact(artifact.id);
      if (!prior) return { ok: false, rejection: { kind: 'no-review-case' } };

      // Exclude the original *human* reviewer. An automated (`system`) rejection
      // records no reviewer, so there is nobody to exclude.
      const excludedReviewer =
        prior.verdict === 'rejected' && prior.reviewer !== null ? prior.reviewer : null;

      const reviewCase = await reviewCaseStore.create({
        artifactId: artifact.id,
        checksReport: prior.checksReport,
        isAppeal: true,
        excludedReviewer,
      });

      const moved = await artifactStore.transition(artifact.id, 'rejected', 'reviewing');
      // The artifact left `rejected` concurrently (a revoke/kill): the appeal case
      // is inert (the queue lists only `reviewing` artifacts) and we report the
      // fault rather than a state the artifact never reached.
      if (!moved) return { ok: false, rejection: { kind: 'transition-failed' } };

      emitAuditEvent(actor, 'artifact.appeal', artifact.id);
      return { ok: true, outcome: { artifact: moved, reviewCase, excludedReviewer } };
    },
  };
}
