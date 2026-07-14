/**
 * Record the OIDC issuer and subject claims on the publisher record (SPEC §2).
 *
 * The R-E0 schema stored identity as a single opaque `oidc_identity` string. The
 * trust model makes the **issuer** the anchor and the `(issuer, subject)` pair
 * the publisher's real identity, and every register/read output must be able to
 * surface those claims — so this migration splits them into their own queryable
 * columns. `oidc_identity` keeps carrying their canonical composite (see
 * `composeOidcIdentity`) and its existing unique index stays the identity key,
 * so nothing downstream that joins on `oidc_identity` breaks.
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`); the columns are nullable because they
 * are additive to a table that predates the split — the publisher store always
 * populates them on insert.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE publisher ADD COLUMN IF NOT EXISTS oidc_issuer  text;
ALTER TABLE publisher ADD COLUMN IF NOT EXISTS oidc_subject text;
`;

export const migration0002: Migration = {
  id: '0002_publisher_oidc_claims',
  up,
};
