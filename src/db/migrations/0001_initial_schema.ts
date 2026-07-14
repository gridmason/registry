/**
 * Initial schema — the six data-model entities (registry-v0 spec §"Data model",
 * SPEC §3 §5 §6).
 *
 * Every statement is idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, guarded
 * trigger drop) so re-running the whole file is a no-op even outside the
 * migration runner's applied-set bookkeeping.
 *
 * Load-bearing constraints later epics rely on:
 *  - Publisher: per-registry namespace-prefix uniqueness (one instance = one DB).
 *  - Artifact: `(publisher, tag, version)` immutability key + a trigger that
 *    freezes identity/content columns once written (SPEC §3 immutability).
 *  - FeedEntry: monotonic `seq` via `GENERATED ALWAYS AS IDENTITY` (SPEC §6
 *    revocation-feed cursor semantics).
 */
import type { Migration } from './types.js';

const up = /* sql */ `
-- gen_random_uuid() is core since PG 13; the extension is a belt-and-braces
-- guarantee on stores that predate that or ship it unloaded.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Publisher ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS publisher (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_identity text        NOT NULL,
  prefix        text        NOT NULL,
  tier          text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publisher_tier_check
    CHECK (tier IN ('community', 'verified', 'operator'))
);
-- Namespace prefixes are unique within a registry; there is no global authority
-- (SPEC §9). One instance == one database, so a plain unique index encodes it.
CREATE UNIQUE INDEX IF NOT EXISTS publisher_prefix_key ON publisher (prefix);
CREATE UNIQUE INDEX IF NOT EXISTS publisher_oidc_identity_key
  ON publisher (oidc_identity);

-- Artifact ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifact (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publisher_id       uuid NOT NULL REFERENCES publisher (id),
  tag                text NOT NULL,
  version            text NOT NULL,
  -- {path -> content hash} of the immutable, content-addressed bundle.
  content_hashes     jsonb NOT NULL,
  -- object-store key of the signed source archive (TF review input, GW-D19).
  source_archive_ref text,
  state              text NOT NULL DEFAULT 'submitted',
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifact_state_check
    CHECK (state IN ('submitted', 'reviewing', 'approved', 'rejected', 'revoked', 'killed'))
);
-- Version immutability: a (publisher, tag, version) triple is published once.
-- R-E1 leans on this to refuse re-upload of an existing version.
CREATE UNIQUE INDEX IF NOT EXISTS artifact_version_key
  ON artifact (publisher_id, tag, version);
CREATE INDEX IF NOT EXISTS artifact_publisher_idx ON artifact (publisher_id);
CREATE INDEX IF NOT EXISTS artifact_state_idx ON artifact (state);

-- Content immutability (SPEC §3): state may advance through its lifecycle, but
-- identity and content columns are frozen once written.
CREATE OR REPLACE FUNCTION artifact_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.publisher_id   IS DISTINCT FROM OLD.publisher_id
     OR NEW.tag         IS DISTINCT FROM OLD.tag
     OR NEW.version     IS DISTINCT FROM OLD.version
     OR NEW.content_hashes IS DISTINCT FROM OLD.content_hashes
     OR NEW.created_at   IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'artifact identity/content is immutable (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artifact_immutable ON artifact;
CREATE TRIGGER artifact_immutable
  BEFORE UPDATE ON artifact
  FOR EACH ROW EXECUTE FUNCTION artifact_immutable_guard();

-- ReviewCase --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_case (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id   uuid NOT NULL REFERENCES artifact (id),
  -- automated-checks report (shared cli/checks module output).
  checks_report jsonb,
  reviewer      text,
  verdict       text,
  -- findings mapped to check ids.
  findings      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  CONSTRAINT review_case_verdict_check
    CHECK (verdict IS NULL OR verdict IN ('approved', 'rejected'))
);
CREATE INDEX IF NOT EXISTS review_case_artifact_idx ON review_case (artifact_id);

-- ReleaseDoc --------------------------------------------------------------
-- The canonical signed document is served from the object store; this row is
-- the queryable record plus a reference to those bytes.
CREATE TABLE IF NOT EXISTS release_doc (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifact (id),
  paths       jsonb NOT NULL,  -- {path -> hash} the runtime may load.
  envelope    jsonb NOT NULL,  -- signature envelope (publisher + countersign).
  log_ref     text,            -- transparency-log (Rekor) reference.
  object_ref  text,            -- object-store key of the canonical signed doc.
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- One release document per artifact (emitted on approval).
CREATE UNIQUE INDEX IF NOT EXISTS release_doc_artifact_key
  ON release_doc (artifact_id);

-- FeedEntry ---------------------------------------------------------------
-- The signed revocation & kill feed. seq is monotonically increasing so hosts
-- track it with a single per-registry cursor (SPEC §6, FR-8).
CREATE TABLE IF NOT EXISTS feed_entry (
  seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  artifact_id uuid NOT NULL REFERENCES artifact (id),
  state       text NOT NULL,
  severity    text,
  reason      text,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feed_entry_state_check
    CHECK (state IN ('published', 'revoked', 'killed'))
);
CREATE INDEX IF NOT EXISTS feed_entry_artifact_idx ON feed_entry (artifact_id);

-- AuditEvent --------------------------------------------------------------
-- Every registry state transition is an auditable event (SPEC §10, FR-12).
CREATE TABLE IF NOT EXISTS audit_event (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor   text        NOT NULL,
  action  text        NOT NULL,
  subject text        NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_event_subject_idx ON audit_event (subject);
CREATE INDEX IF NOT EXISTS audit_event_at_idx ON audit_event (at);
`;

export const migration0001: Migration = {
  id: '0001_initial_schema',
  up,
};
