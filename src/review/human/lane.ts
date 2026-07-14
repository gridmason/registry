/**
 * The single human review lane (FR-4; SPEC §4, §4a).
 *
 * This is the one human review lane the SCOPE-minimal Phase B cut ships — not the
 * T1/TF tier ladder with SLAs (flagship policy, Phase C). It acts on the
 * `ReviewCase` rows the automated stage (#8) opened for artifacts it moved to
 * `reviewing`: a reviewer lists the queue, reads a case's automated report, and
 * records a verdict (approve/reject) with findings that map to the report's check
 * ids.
 *
 * Two rules are load-bearing:
 *
 *  - **reviewer ≠ author** — the reviewer's OIDC identity must differ from the
 *    artifact publisher's. The single exception is the disclosed flagship waiver
 *    (SPEC §4a): when `selfReviewWaiver` is on, an operator may self-approve, the
 *    fact is recorded on the review case (`waiverUsed`), and it gets its own audit
 *    event so the countersign/transparency step (#10) can flag the release. With
 *    the waiver off — always, on every self-host instance — self-review is refused.
 *  - **findings map to check ids** — every finding references a check id from the
 *    persisted automated report (or `manual`); validated before the verdict lands.
 *
 * A verdict transitions the artifact `reviewing → approved`/`rejected` via the
 * guarded {@link ArtifactStore.transition} and emits an {@link emitAuditEvent}
 * (SPEC §10, FR-12). Countersign + release document follow on approval (#10) and
 * are out of scope here.
 */
import type { ArtifactRecord } from '../../artifact/types.js';
import type { ArtifactStore } from '../../artifact/store.js';
import type { OidcIdentity } from '../../auth/oidc.js';
import { emitAuditEvent } from '../../audit/index.js';
import { composeOidcIdentity } from '../../publisher/types.js';
import type { PublisherStore } from '../../publisher/store.js';
import type { ReviewCaseRecord, ReviewCaseStore } from '../store.js';
import { validateFindings, type FindingsRejection } from './findings.js';
import { verdictOf, type VerdictDecision } from './types.js';

export interface SubmitVerdictInput {
  /** The review case being decided. */
  readonly caseId: string;
  /** The reviewer's verified OIDC identity. */
  readonly reviewer: OidcIdentity;
  readonly decision: VerdictDecision;
  /** Raw findings from the request body; validated against the report here. */
  readonly findings: unknown;
}

/** Why a verdict was refused. Callers (the route) map each to a response. */
export type VerdictRejection =
  | { readonly kind: 'case-not-found' }
  | { readonly kind: 'not-in-review' }
  | { readonly kind: 'self-review' }
  | { readonly kind: 'findings'; readonly code: FindingsRejection; readonly message: string }
  | { readonly kind: 'already-decided' };

export interface VerdictOutcome {
  readonly reviewCase: ReviewCaseRecord;
  readonly artifact: ArtifactRecord;
  /** Whether the verdict rode the flagship self-review waiver (SPEC §4a). */
  readonly waiverUsed: boolean;
}

export type SubmitVerdictResult =
  | { readonly ok: true; readonly outcome: VerdictOutcome }
  | { readonly ok: false; readonly rejection: VerdictRejection };

export interface HumanReviewLaneDeps {
  readonly artifactStore: ArtifactStore;
  readonly reviewCaseStore: ReviewCaseStore;
  readonly publisherStore: PublisherStore;
  /** The disclosed flagship self-review waiver (SPEC §4a); off for self-host. */
  readonly selfReviewWaiver: boolean;
}

/** A pending case surfaced by the queue: the case plus its artifact. */
export interface PendingCase {
  readonly reviewCase: ReviewCaseRecord;
  readonly artifact: ArtifactRecord;
}

export interface HumanReviewLane {
  /** Every artifact awaiting a human verdict (`reviewing`, undecided case), oldest first. */
  listQueue(): Promise<PendingCase[]>;
  /** A single case with its artifact, or `null` if the case id is unknown. */
  getCase(caseId: string): Promise<PendingCase | null>;
  /** Record a reviewer's verdict, enforcing reviewer≠author + findings mapping. */
  submitVerdict(input: SubmitVerdictInput): Promise<SubmitVerdictResult>;
}

export function createHumanReviewLane(deps: HumanReviewLaneDeps): HumanReviewLane {
  const { artifactStore, reviewCaseStore, publisherStore, selfReviewWaiver } = deps;

  return {
    async listQueue() {
      // The queue is the artifacts currently in `reviewing`; each carries the
      // review case the automated stage opened. Guard on an undecided case so a
      // case mid-transition never lingers in the queue.
      const artifacts = await artifactStore.listByState('reviewing');
      const pending: PendingCase[] = [];
      for (const artifact of artifacts) {
        const reviewCase = await reviewCaseStore.findByArtifact(artifact.id);
        if (reviewCase && reviewCase.verdict === null) {
          pending.push({ reviewCase, artifact });
        }
      }
      return pending;
    },

    async getCase(caseId) {
      const reviewCase = await reviewCaseStore.findById(caseId);
      if (!reviewCase) return null;
      const artifact = await artifactStore.findById(reviewCase.artifactId);
      // A review case always references a real artifact (FK), so a missing one is
      // an integrity fault, not a normal 404 — treat the case as unresolvable.
      if (!artifact) return null;
      return { reviewCase, artifact };
    },

    async submitVerdict(input) {
      const reviewCase = await reviewCaseStore.findById(input.caseId);
      if (!reviewCase) return { ok: false, rejection: { kind: 'case-not-found' } };

      const artifact = await artifactStore.findById(reviewCase.artifactId);
      // Only an artifact still in `reviewing` can take a verdict: an already
      // decided (or auto-rejected) artifact is not in the human queue.
      if (!artifact || artifact.state !== 'reviewing') {
        return { ok: false, rejection: { kind: 'not-in-review' } };
      }

      // Findings must map to the report's check ids before anything is recorded.
      const validated = validateFindings(input.findings, reviewCase.checksReport);
      if (!validated.ok) {
        return {
          ok: false,
          rejection: { kind: 'findings', code: validated.code, message: validated.message },
        };
      }

      // reviewer ≠ author: compare the reviewer's identity to the artifact
      // publisher's. The publisher record is the authorship anchor (SPEC §2).
      const reviewerId = composeOidcIdentity(input.reviewer.issuer, input.reviewer.subject);
      const author = await publisherStore.findById(artifact.publisherId);
      const authorId = author ? composeOidcIdentity(author.issuer, author.subject) : null;
      const isSelfReview = authorId !== null && authorId === reviewerId;
      if (isSelfReview && !selfReviewWaiver) {
        return { ok: false, rejection: { kind: 'self-review' } };
      }
      const waiverUsed = isSelfReview && selfReviewWaiver;

      const verdict = verdictOf(input.decision);
      // Record the verdict first: its `verdict IS NULL` guard is the concurrency
      // gate that decides which reviewer wins, so the artifact is only moved after
      // this reviewer has authoritatively claimed the decision.
      const decided = await reviewCaseStore.recordVerdict({
        caseId: reviewCase.id,
        reviewer: reviewerId,
        verdict,
        findings: validated.findings,
        waiverUsed,
      });
      if (!decided) return { ok: false, rejection: { kind: 'already-decided' } };

      const target = verdict; // 'approved' | 'rejected' are the target states too.
      const moved = await artifactStore.transition(artifact.id, 'reviewing', target);

      // A waiver use gets its own audit event (SPEC §4a) so the transparency step
      // can flag the release, then the verdict transition itself is audited.
      if (waiverUsed) {
        emitAuditEvent(reviewerId, 'review.waiver', artifact.id);
      }
      emitAuditEvent(reviewerId, `review.${target}`, artifact.id);

      return {
        ok: true,
        outcome: { reviewCase: decided, artifact: moved ?? { ...artifact, state: target }, waiverUsed },
      };
    },
  };
}
