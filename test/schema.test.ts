import { describe, expect, it } from 'vitest';

import { migration0001 } from '../src/db/migrations/0001_initial_schema.js';
import { migration0002 } from '../src/db/migrations/0002_publisher_oidc_claims.js';
import { migrations } from '../src/db/migrations/index.js';

/**
 * Structural guards over the DDL. These do not execute SQL (that happens against
 * the compose Postgres / in CI) but they pin the load-bearing constraints later
 * epics depend on, so an accidental edit that drops one fails here.
 */
describe('initial schema', () => {
  const sql = migration0001.up;

  it('creates every data-model table', () => {
    for (const table of [
      'publisher',
      'artifact',
      'review_case',
      'release_doc',
      'feed_entry',
      'audit_event',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('enforces per-registry publisher prefix uniqueness', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS publisher_prefix_key/);
  });

  it('enforces artifact (publisher, tag, version) immutability keys', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS artifact_version_key\s+ON artifact \(publisher_id, tag, version\)/,
    );
    expect(sql).toContain('CREATE TRIGGER artifact_immutable');
  });

  it('constrains the artifact state to the spec lifecycle', () => {
    for (const state of [
      'submitted',
      'reviewing',
      'approved',
      'rejected',
      'revoked',
      'killed',
    ]) {
      expect(sql).toContain(`'${state}'`);
    }
  });

  it('gives FeedEntry a monotonic identity seq', () => {
    expect(sql).toMatch(/seq\s+bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY/);
  });

  it('is registered exactly once in the ordered set', () => {
    expect(migrations.filter((m) => m.id === migration0001.id)).toHaveLength(1);
  });
});

describe('publisher OIDC claims migration', () => {
  it('adds the issuer and subject columns idempotently', () => {
    const sql = migration0002.up;
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS oidc_issuer/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS oidc_subject/);
  });

  it('is registered after the initial schema, exactly once', () => {
    const ids = migrations.map((m) => m.id);
    expect(ids).toContain(migration0002.id);
    expect(ids.indexOf(migration0002.id)).toBe(ids.indexOf(migration0001.id) + 1);
    expect(migrations.filter((m) => m.id === migration0002.id)).toHaveLength(1);
  });
});
