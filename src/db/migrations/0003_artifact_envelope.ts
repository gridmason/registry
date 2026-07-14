/**
 * Attach the publisher signature envelope to the artifact record (FR-1, SPEC §2).
 *
 * The R-E0 schema modelled the release document's envelope (`release_doc.envelope`,
 * emitted at countersign time) but had nowhere to keep the **publisher's** signature
 * envelope that rides in with the upload. Publish intake (#7) records that envelope
 * alongside the submitted artifact — before any review or countersign — so this
 * migration adds the column.
 *
 * This phase stores the envelope with **structural validation only** (opaque JSON,
 * shape-checked); strict typing/verification against the `@gridmason/protocol`
 * envelope types is deferred until protocol P-E3 publishes them, and full
 * cryptographic verification lands with countersign (#10). The column is therefore
 * `jsonb` (any shape) and nullable, and it is intentionally **not** covered by the
 * `artifact_immutable_guard` trigger — the content-addressed identity columns are
 * what immutability protects; the envelope is metadata attached once at intake.
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`) and additive.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE artifact ADD COLUMN IF NOT EXISTS envelope jsonb;
`;

export const migration0003: Migration = {
  id: '0003_artifact_envelope',
  up,
};
