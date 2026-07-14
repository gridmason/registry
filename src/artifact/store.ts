/**
 * Artifact persistence over the `artifact` table.
 *
 * The service depends on the {@link ArtifactStore} interface, not on `pg`
 * directly: {@link createPostgresArtifactStore} backs production and the dev
 * compose, while {@link InMemoryArtifactStore} backs tests and lets the publish
 * API run without a live database (matching the publisher/object-store pattern).
 *
 * Version immutability is enforced at the schema level — the unique index on
 * `(publisher_id, tag, version)` (migration 0001) — and surfaced here as a typed
 * {@link ArtifactConflict} so the route answers a clean `409` instead of a raw
 * driver error. A published `(publisher, tag, version)` is never overwritten
 * (SPEC §3): the reviewed hash is the runnable artifact.
 */
import type { Postgres } from '../db/postgres.js';
import type { Logger } from '../logging/index.js';
import type { ArtifactRecord, ArtifactState, ContentHashMap } from './types.js';

export interface CreateArtifactInput {
  readonly publisherId: string;
  readonly tag: string;
  readonly version: string;
  readonly contentHashes: ContentHashMap;
  readonly sourceArchiveRef: string | null;
  readonly envelope: unknown;
}

/** Which uniqueness invariant a create hit. Only version immutability applies. */
export type ArtifactConflict = 'version';

export type CreateArtifactResult =
  | { readonly ok: true; readonly record: ArtifactRecord }
  | { readonly ok: false; readonly conflict: ArtifactConflict };

export interface ArtifactStore {
  /**
   * Persist a submitted artifact. Re-inserting an existing
   * `(publisher, tag, version)` resolves to a typed {@link ArtifactConflict}
   * rather than throwing, so the route returns `409` (immutability, SPEC §3).
   */
  create(input: CreateArtifactInput): Promise<CreateArtifactResult>;
  findById(id: string): Promise<ArtifactRecord | null>;
  findByVersion(
    publisherId: string,
    tag: string,
    version: string,
  ): Promise<ArtifactRecord | null>;
}

interface ArtifactRow {
  readonly id: string;
  readonly publisher_id: string;
  readonly tag: string;
  readonly version: string;
  readonly content_hashes: ContentHashMap;
  readonly source_archive_ref: string | null;
  readonly envelope: unknown;
  readonly state: string;
  readonly created_at: Date;
}

function rowToRecord(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    tag: row.tag,
    version: row.version,
    contentHashes: row.content_hashes,
    sourceArchiveRef: row.source_archive_ref,
    envelope: row.envelope,
    // The DB check constraint guarantees the state is one of the lifecycle values.
    state: row.state as ArtifactState,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS =
  'id, publisher_id, tag, version, content_hashes, source_archive_ref, envelope, state, created_at';

// The unique constraint (index name, migration 0001) whose violation maps to a
// typed conflict. Classified by the *exact* constraint name, never a substring
// guess, so a violation of any other unique constraint added later is not
// silently mislabeled as a version conflict.
const VERSION_CONSTRAINT = 'artifact_version_key';

/**
 * Map a Postgres unique-violation (SQLSTATE 23505) to the version-immutability
 * conflict. An unrecognised constraint returns `null`: the raw error then
 * propagates (a 500) rather than being reported as a false version conflict, and
 * the constraint is logged so the unhandled case is visible.
 */
function conflictOf(err: unknown, logger?: Logger): ArtifactConflict | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, constraint } = err as { code?: string; constraint?: string };
  if (code !== '23505') return null;
  if (constraint === VERSION_CONSTRAINT) return 'version';
  logger?.warn(
    { code, constraint },
    'unclassified unique violation on artifact insert; surfacing as 500',
  );
  return null;
}

export function createPostgresArtifactStore(
  postgres: Postgres,
  logger?: Logger,
): ArtifactStore {
  return {
    async create(input) {
      try {
        const { rows } = await postgres.query(
          `INSERT INTO artifact
             (publisher_id, tag, version, content_hashes, source_archive_ref, envelope, state)
           VALUES ($1, $2, $3, $4, $5, $6, 'submitted')
           RETURNING ${SELECT_COLUMNS}`,
          [
            input.publisherId,
            input.tag,
            input.version,
            input.contentHashes,
            input.sourceArchiveRef,
            input.envelope,
          ],
        );
        return { ok: true, record: rowToRecord(rows[0] as ArtifactRow) };
      } catch (err) {
        const conflict = conflictOf(err, logger);
        if (conflict) return { ok: false, conflict };
        throw err;
      }
    },

    async findById(id) {
      const { rows } = await postgres.query(
        `SELECT ${SELECT_COLUMNS} FROM artifact WHERE id = $1`,
        [id],
      );
      return rows[0] ? rowToRecord(rows[0] as ArtifactRow) : null;
    },

    async findByVersion(publisherId, tag, version) {
      const { rows } = await postgres.query(
        `SELECT ${SELECT_COLUMNS}
           FROM artifact WHERE publisher_id = $1 AND tag = $2 AND version = $3`,
        [publisherId, tag, version],
      );
      return rows[0] ? rowToRecord(rows[0] as ArtifactRow) : null;
    },
  };
}

/**
 * In-memory {@link ArtifactStore}. Backs tests and lets the publish API run
 * without a live database; never for production (nothing is durable or shared).
 */
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly records: ArtifactRecord[] = [];
  private counter = 0;

  create(input: CreateArtifactInput): Promise<CreateArtifactResult> {
    const clash = this.records.some(
      (r) =>
        r.publisherId === input.publisherId &&
        r.tag === input.tag &&
        r.version === input.version,
    );
    if (clash) return Promise.resolve({ ok: false, conflict: 'version' });
    const record: ArtifactRecord = {
      id: `art-${++this.counter}`,
      publisherId: input.publisherId,
      tag: input.tag,
      version: input.version,
      contentHashes: input.contentHashes,
      sourceArchiveRef: input.sourceArchiveRef,
      envelope: input.envelope,
      state: 'submitted',
      createdAt: new Date(),
    };
    this.records.push(record);
    return Promise.resolve({ ok: true, record });
  }

  findById(id: string): Promise<ArtifactRecord | null> {
    return Promise.resolve(this.records.find((r) => r.id === id) ?? null);
  }

  findByVersion(
    publisherId: string,
    tag: string,
    version: string,
  ): Promise<ArtifactRecord | null> {
    return Promise.resolve(
      this.records.find(
        (r) =>
          r.publisherId === publisherId && r.tag === tag && r.version === version,
      ) ?? null,
    );
  }
}
