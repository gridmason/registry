/**
 * API projections for the human review lane (the ops/queue surface, SPEC §4, §8).
 *
 * Every projection is source-qualified through the embedded artifact response
 * (SPEC §9). The queue list carries a **summary** of each case's automated report
 * (status + the check ids a finding may reference); the single-case view carries
 * the **full** report so a reviewer sees every check result before deciding.
 */
import { toArtifactResponse, type ArtifactResponse } from '../../artifact/presenter.js';
import type { CheckResult } from '@gridmason/cli/checks';
import type { PendingCase } from './lane.js';
import { reportCheckIds } from './findings.js';
import type { ReviewCaseRecord } from '../store.js';
import type { ReviewFinding } from './types.js';

/** A row in the review queue: the case, its artifact, and a report summary. */
export interface ReviewQueueItemResponse {
  readonly caseId: string;
  readonly createdAt: string;
  readonly artifact: ArtifactResponse;
  readonly checks: {
    readonly status: 'pass' | 'fail';
    readonly module: string;
    readonly version: string;
    /** The check ids a finding may reference (report ids plus `manual`). */
    readonly checkIds: readonly string[];
  };
}

/** The full single-case view: artifact, the complete report, and any verdict. */
export interface ReviewCaseResponse {
  readonly caseId: string;
  readonly createdAt: string;
  readonly artifact: ArtifactResponse;
  readonly report: {
    readonly status: 'pass' | 'fail';
    readonly module: string;
    readonly version: string;
    readonly results: readonly CheckResult[];
  };
  readonly verdict: ReviewVerdictProjection | null;
}

/** The recorded verdict, present once a case is decided. */
export interface ReviewVerdictProjection {
  readonly decision: 'approved' | 'rejected';
  readonly reviewer: string;
  readonly findings: readonly ReviewFinding[];
  readonly waiverUsed: boolean;
  readonly decidedAt: string;
}

/** The acknowledgement returned when a verdict is accepted. */
export interface VerdictAcceptedResponse {
  readonly caseId: string;
  readonly decision: 'approved' | 'rejected';
  /** The artifact's state after the transition (`approved`/`rejected`). */
  readonly artifactState: string;
  readonly waiverUsed: boolean;
  readonly findings: readonly ReviewFinding[];
}

function verdictProjection(record: ReviewCaseRecord): ReviewVerdictProjection | null {
  if (record.verdict === null || record.reviewer === null || record.decidedAt === null) {
    return null;
  }
  return {
    decision: record.verdict,
    reviewer: record.reviewer,
    findings: record.findings ?? [],
    waiverUsed: record.waiverUsed,
    decidedAt: record.decidedAt.toISOString(),
  };
}

export function toReviewQueueItem(
  { reviewCase, artifact }: PendingCase,
  registryId: string,
): ReviewQueueItemResponse {
  const report = reviewCase.checksReport;
  return {
    caseId: reviewCase.id,
    createdAt: reviewCase.createdAt.toISOString(),
    artifact: toArtifactResponse(artifact, registryId),
    checks: {
      status: report.status,
      module: report.checksModule,
      version: report.checksVersion,
      checkIds: [...reportCheckIds(report)],
    },
  };
}

export function toReviewCaseResponse(
  { reviewCase, artifact }: PendingCase,
  registryId: string,
): ReviewCaseResponse {
  const report = reviewCase.checksReport;
  return {
    caseId: reviewCase.id,
    createdAt: reviewCase.createdAt.toISOString(),
    artifact: toArtifactResponse(artifact, registryId),
    report: {
      status: report.status,
      module: report.checksModule,
      version: report.checksVersion,
      results: report.results,
    },
    verdict: verdictProjection(reviewCase),
  };
}
