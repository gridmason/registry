/**
 * Persist the full transparency-log inclusion entry and the flagship-waiver flag
 * on the release document (SPEC §3, §4a; #10).
 *
 * The R-E0 schema modelled `release_doc` with a `log_ref` (a reference to the log
 * entry) but not the entry itself. Countersign (#10) needs the **full**
 * Rekor-shaped {@link TransparencyLogEntry} persisted, not just a reference: SPEC
 * §3 requires inclusion proofs to be *embedded* so an air-gapped host verifies the
 * identical chain offline, and a host that reads a release document must be able
 * to run `@gridmason/protocol`'s `verifyLogInclusion` from it directly. So this
 * adds `log_entry jsonb`.
 *
 * It also adds `waiver_flagged` — SPEC §4a requires every release approved under
 * the disclosed flagship self-review waiver to be flagged in its transparency-log
 * entry. The flag is carried inside the logged leaf (`log_entry.canonicalBody`);
 * this column surfaces it as a queryable boolean so an auditor can list flagged
 * releases without decoding every leaf.
 *
 * Both are idempotent (`ADD COLUMN IF NOT EXISTS`) and additive; `waiver_flagged`
 * defaults `false`, correct for every non-waiver release and every self-host
 * instance (which never enables the waiver).
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE release_doc
  ADD COLUMN IF NOT EXISTS log_entry jsonb;
ALTER TABLE release_doc
  ADD COLUMN IF NOT EXISTS waiver_flagged boolean NOT NULL DEFAULT false;
`;

export const migration0005: Migration = {
  id: '0005_release_doc_log_entry',
  up,
};
