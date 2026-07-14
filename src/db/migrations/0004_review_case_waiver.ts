/**
 * Record whether the flagship self-review waiver was used on a review case
 * (SPEC §4a).
 *
 * The R-E0 schema modelled the human verdict columns (`reviewer`, `verdict`,
 * `findings`, `decided_at`) but had nowhere to record the one exceptional path
 * the human review lane (#9) permits: the disclosed flagship waiver that lets an
 * operator self-approve while the flagship is single-rostered (SPEC §4a). When a
 * verdict rides that waiver the fact **must** be persisted so the countersign /
 * transparency step (#10) can flag the affected release — so this migration adds
 * the flag.
 *
 * It is a plain boolean defaulting to `false`: the overwhelming majority of
 * verdicts are reviewer≠author and never touch the waiver, and every self-host
 * instance leaves the waiver off entirely, so `false` is the correct default for
 * both existing and future rows.
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`) and additive.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE review_case
  ADD COLUMN IF NOT EXISTS waiver_used boolean NOT NULL DEFAULT false;
`;

export const migration0004: Migration = {
  id: '0004_review_case_waiver',
  up,
};
