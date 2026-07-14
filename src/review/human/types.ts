/**
 * The human review lane's value types (FR-4; SPEC §4, §4a).
 *
 * A reviewer's verdict is `approve` or `reject` plus a set of **findings**, each
 * of which references a check id from the artifact's automated-checks report so a
 * reader can trace the finding back to the check that surfaced it (FR-4). A
 * finding that is not tied to any automated check — a judgement the reviewer made
 * by hand — references the sentinel {@link MANUAL_FINDING} instead.
 */

/** A reviewer's decision. Maps to the artifact's terminal review state. */
export type VerdictDecision = 'approve' | 'reject';

/** The persisted verdict value (the `review_case.verdict` column domain). */
export type Verdict = 'approved' | 'rejected';

/**
 * The check-id a finding references when it is the reviewer's own judgement
 * rather than one of the automated checks. A finding's `checkId` is either this
 * sentinel or the `id` of a {@link CheckResult} in the review case's report.
 */
export const MANUAL_FINDING = 'manual';

/**
 * One finding a reviewer records against an artifact. `checkId` is the automated
 * check the finding traces to (a `CheckResult.id` from the report) or
 * {@link MANUAL_FINDING}; `detail` is the reviewer's note explaining it.
 */
export interface ReviewFinding {
  /** A report check id, or {@link MANUAL_FINDING} for a hand-made judgement. */
  readonly checkId: string;
  /** The reviewer's explanation for this finding. */
  readonly detail: string;
}

/** Map a decision to the verdict value stored on the review case. */
export function verdictOf(decision: VerdictDecision): Verdict {
  return decision === 'approve' ? 'approved' : 'rejected';
}
