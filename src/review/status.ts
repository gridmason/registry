/**
 * The publisher-facing review-status projection (`GET /v1/artifacts/:id`).
 *
 * This is the surface `gridmason publish` polls after upload and `gridmason
 * appeal` reads: the artifact's lifecycle `state` plus, when the review carried
 * any, its **findings keyed by the shared `@gridmason/cli/checks` check ids**
 * (the same vocabulary a local `gridmason lint` prints). It is distinct from the
 * reviewer-only lane view (`src/review/human/presenter`): a publisher sees the
 * decision that affects their own artifact, not the whole reviewer queue.
 *
 * The projection matches the CLI's forward contract (cli PR #63,
 * `test/helpers/fake-registry.ts`): the body is the source-qualified artifact
 * record (the same {@link toArtifactResponse} the upload returns, so the CLI's
 * `parseRecord` reads an identical shape) plus an optional `review` object with
 * up to two arrays the CLI's `parseFindings` merges:
 *
 *  - `results` — the automated report's non-`pass` {@link CheckResult}s
 *    (`{ id, status, message }`), the actionable findings of an automated
 *    rejection or the warnings on an otherwise-clean artifact.
 *  - `findings` — a human reviewer's {@link ReviewFinding}s (`{ checkId, detail }`),
 *    each referencing a report check id or the `manual` sentinel.
 *
 * `review` is omitted entirely when there is nothing to report (a clean pending
 * or freshly-approved artifact), matching the fake's "no `review` key" behaviour.
 */
import { toArtifactResponse, type ArtifactResponse } from '../artifact/presenter.js';
import type { ArtifactRecord } from '../artifact/types.js';
import type { CheckResult } from '@gridmason/cli/checks';
import type { ReviewCaseRecord } from './store.js';
import type { ReviewFinding } from './human/types.js';

/** The `review` object on a status response; each array is present only when non-empty. */
export interface PublisherReviewProjection {
  /** Human reviewer findings (`{ checkId, detail }`), present once a case is decided. */
  readonly findings?: readonly ReviewFinding[];
  /** Automated report results, non-`pass` only (`{ id, status, message }`). */
  readonly results?: readonly CheckResult[];
}

/** A publisher status response: the artifact record plus any review findings. */
export interface PublisherArtifactStatusResponse extends ArtifactResponse {
  readonly review?: PublisherReviewProjection;
}

/**
 * Build the review projection for an artifact's most-recent review case, or
 * `null` when there is nothing a publisher would act on. Human findings appear
 * only once the case is decided (a `verdict` is recorded); automated results are
 * filtered to the non-`pass` findings the CLI surfaces.
 */
function reviewProjection(
  reviewCase: ReviewCaseRecord | null,
): PublisherReviewProjection | null {
  if (!reviewCase) return null;

  const findings = reviewCase.verdict !== null ? reviewCase.findings ?? [] : [];
  const results = reviewCase.checksReport.results.filter((r) => r.status !== 'pass');

  if (findings.length === 0 && results.length === 0) return null;
  return {
    ...(findings.length > 0 ? { findings } : {}),
    ...(results.length > 0 ? { results } : {}),
  };
}

export function toPublisherArtifactStatus(
  record: ArtifactRecord,
  reviewCase: ReviewCaseRecord | null,
  registryId: string,
): PublisherArtifactStatusResponse {
  const review = reviewProjection(reviewCase);
  return {
    ...toArtifactResponse(record, registryId),
    ...(review ? { review } : {}),
  };
}
