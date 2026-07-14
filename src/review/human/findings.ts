/**
 * Parse and validate reviewer-submitted findings against the automated report
 * (FR-4: findings map to check ids).
 *
 * The acceptance rule is that every finding references a check id present in the
 * artifact's automated-checks report — or the {@link MANUAL_FINDING} sentinel for
 * a judgement the reviewer made by hand. This module turns the untrusted request
 * body into a typed {@link ReviewFinding}[] or a precise rejection, so the route
 * answers a clean `400`/`422` instead of persisting an untraceable finding.
 */
import type { AutomatedReviewReport } from '../report.js';
import { MANUAL_FINDING, type ReviewFinding } from './types.js';

/** Why a findings payload was rejected. Callers switch on the code. */
export type FindingsRejection =
  | 'not-an-array'
  | 'malformed-finding'
  | 'unknown-check-id';

export type ValidateFindingsResult =
  | { readonly ok: true; readonly findings: readonly ReviewFinding[] }
  | { readonly ok: false; readonly code: FindingsRejection; readonly message: string };

/** The set of check ids a finding may reference: every report id plus `manual`. */
export function reportCheckIds(report: AutomatedReviewReport): ReadonlySet<string> {
  const ids = new Set<string>([MANUAL_FINDING]);
  for (const result of report.results) ids.add(result.id);
  return ids;
}

/**
 * Validate the raw `findings` value from a verdict request against `report`.
 * Accepts an array (possibly empty — a clean approval carries no findings) whose
 * every entry is `{ checkId: string, detail: string }` with a `checkId` that is a
 * report check id or {@link MANUAL_FINDING}. The first offending entry decides the
 * rejection, so the reviewer gets a specific, fixable error.
 */
export function validateFindings(
  raw: unknown,
  report: AutomatedReviewReport,
): ValidateFindingsResult {
  if (raw === undefined) return { ok: true, findings: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'not-an-array', message: 'findings must be an array' };
  }

  const allowed = reportCheckIds(report);
  const findings: ReviewFinding[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return {
        ok: false,
        code: 'malformed-finding',
        message: 'each finding must be an object with checkId and detail',
      };
    }
    const { checkId, detail } = entry as { checkId?: unknown; detail?: unknown };
    if (typeof checkId !== 'string' || checkId === '') {
      return {
        ok: false,
        code: 'malformed-finding',
        message: 'each finding must carry a non-empty string checkId',
      };
    }
    if (typeof detail !== 'string' || detail === '') {
      return {
        ok: false,
        code: 'malformed-finding',
        message: `finding for check "${checkId}" must carry a non-empty string detail`,
      };
    }
    if (!allowed.has(checkId)) {
      return {
        ok: false,
        code: 'unknown-check-id',
        message: `finding references check id "${checkId}", which is not in the automated report (use "manual" for a hand-made finding)`,
      };
    }
    findings.push({ checkId, detail });
  }
  return { ok: true, findings };
}
