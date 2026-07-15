/**
 * Record that a review case is an **appeal** and which reviewer it must not be
 * decided by (SPEC §4: "Appeals → a second reviewer (never the original)").
 *
 * A publisher appeal re-opens a rejected artifact for human review by routing it
 * to a *second* reviewer. Because {@link recordVerdict} is single-shot (a decided
 * case is never re-decided), the appeal opens a **new** review case for the
 * artifact rather than reusing the rejected one. Two facts must ride on that new
 * case so the human lane can enforce the second-reviewer rule when a verdict is
 * later submitted:
 *
 *  - `is_appeal` — this case is a re-review, not a first-pass one (informational:
 *    lets the transparency step and reviewer surface flag an appealed decision).
 *  - `excluded_reviewer` — the identity of the reviewer who cast the *original*
 *    rejection, in the `composeOidcIdentity` composite form. The lane refuses a
 *    verdict from this identity (appeal reviewer ≠ original reviewer), on top of
 *    the standing reviewer ≠ author rule. It is `null` when the original rejection
 *    was the automated stage's (`system`, no human reviewer to exclude).
 *
 * Both are additive and idempotent (`ADD COLUMN IF NOT EXISTS`): `is_appeal`
 * defaults to `false` and `excluded_reviewer` to `NULL`, which is exactly correct
 * for every existing first-pass case and every case the automated stage opens.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE review_case
  ADD COLUMN IF NOT EXISTS is_appeal boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS excluded_reviewer text;
`;

export const migration0006: Migration = {
  id: '0006_review_case_appeal',
  up,
};
