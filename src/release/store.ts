/**
 * ReleaseDoc persistence over the `release_doc` table (migrations 0001, 0005).
 *
 * The release document is the signed, published record of an approved artifact
 * (SPEC §3): the `{ path → hash }` map of every file the runtime may load, the
 * completed dual-signature envelope (publisher + registry countersignature), and
 * the transparency-log inclusion entry that anchors it. One row per artifact
 * (unique index, migration 0001), emitted once on approval by the countersign
 * stage (#10) and read by the resolution/serving surface (#12).
 *
 * Like the other stores the service depends on the {@link ReleaseDocStore}
 * interface, not on `pg`: {@link createPostgresReleaseDocStore} backs production
 * while {@link InMemoryReleaseDocStore} backs tests.
 */
import type {
  ReleaseDoc,
  SignatureEnvelope,
  TransparencyLogEntry,
} from '@gridmason/protocol';

import type { Postgres } from '../db/postgres.js';
import { RELEASE_DOC_FORMAT_VERSION } from './release-doc.js';

export interface CreateReleaseDocInput {
  /** The artifact table id (uuid) this release document is for (FK). */
  readonly artifactId: string;
  /** The signed release document ({@link ReleaseDoc.files} is persisted as `paths`). */
  readonly releaseDoc: ReleaseDoc;
  /** The completed dual-signature envelope. */
  readonly envelope: SignatureEnvelope;
  /** The transparency-log reference (log id + leaf index). */
  readonly logRef: string;
  /** The full Rekor-shaped inclusion entry (embedded so hosts verify offline). */
  readonly logEntry: TransparencyLogEntry;
  /** Whether this release was approved under the disclosed flagship waiver (SPEC §4a). */
  readonly waiverFlagged: boolean;
  /** Object-store key of the canonical signed doc, populated by serving (#12). */
  readonly objectRef?: string | null;
}

/** A stored release document. */
export interface ReleaseDocRecord {
  readonly id: string;
  readonly artifactId: string;
  readonly releaseDoc: ReleaseDoc;
  readonly envelope: SignatureEnvelope;
  readonly logRef: string | null;
  readonly logEntry: TransparencyLogEntry | null;
  readonly waiverFlagged: boolean;
  readonly objectRef: string | null;
  readonly createdAt: Date;
}

export interface ReleaseDocStore {
  /** Persist a release document; one per artifact (unique on `artifact_id`). */
  create(input: CreateReleaseDocInput): Promise<ReleaseDocRecord>;
  /** The release document for an artifact, or `null` if none has been emitted. */
  findByArtifact(artifactId: string): Promise<ReleaseDocRecord | null>;
}

interface ReleaseDocRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly paths: ReleaseDoc['files'];
  readonly envelope: SignatureEnvelope;
  readonly log_ref: string | null;
  readonly log_entry: TransparencyLogEntry | null;
  readonly object_ref: string | null;
  readonly waiver_flagged: boolean;
  readonly created_at: Date;
}

/**
 * Reconstruct the signed {@link ReleaseDoc} from a row. `paths` holds the file
 * map; the version-qualified artifact id is authoritative in the signed envelope
 * subject; the release-doc format version is the single version this cut emits.
 * The three reproduce the exact canonical bytes the publisher hashed — a Phase-C
 * format bump adds a stored `format_version` column rather than a constant.
 */
function rowToRecord(row: ReleaseDocRow): ReleaseDocRecord {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    releaseDoc: {
      formatVersion: RELEASE_DOC_FORMAT_VERSION,
      artifact: row.envelope.subject.artifact,
      files: row.paths,
    },
    envelope: row.envelope,
    logRef: row.log_ref,
    logEntry: row.log_entry,
    waiverFlagged: row.waiver_flagged,
    objectRef: row.object_ref,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS =
  'id, artifact_id, paths, envelope, log_ref, log_entry, object_ref, waiver_flagged, created_at';

export function createPostgresReleaseDocStore(postgres: Postgres): ReleaseDocStore {
  return {
    async create(input) {
      const { rows } = await postgres.query(
        `INSERT INTO release_doc
           (artifact_id, paths, envelope, log_ref, log_entry, object_ref, waiver_flagged)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${SELECT_COLUMNS}`,
        [
          input.artifactId,
          input.releaseDoc.files,
          input.envelope,
          input.logRef,
          input.logEntry,
          input.objectRef ?? null,
          input.waiverFlagged,
        ],
      );
      return rowToRecord(rows[0] as ReleaseDocRow);
    },

    async findByArtifact(artifactId) {
      const { rows } = await postgres.query(
        `SELECT ${SELECT_COLUMNS} FROM release_doc WHERE artifact_id = $1`,
        [artifactId],
      );
      return rows[0] ? rowToRecord(rows[0] as ReleaseDocRow) : null;
    },
  };
}

/**
 * In-memory {@link ReleaseDocStore}. Backs tests and lets the countersign stage
 * run without a live database; never for production (nothing is durable).
 */
export class InMemoryReleaseDocStore implements ReleaseDocStore {
  private readonly records: ReleaseDocRecord[] = [];
  private counter = 0;

  create(input: CreateReleaseDocInput): Promise<ReleaseDocRecord> {
    if (this.records.some((r) => r.artifactId === input.artifactId)) {
      // Mirror the Postgres unique index: one release document per artifact.
      return Promise.reject(new Error(`release doc already exists for ${input.artifactId}`));
    }
    const record: ReleaseDocRecord = {
      id: `rd-${++this.counter}`,
      artifactId: input.artifactId,
      releaseDoc: input.releaseDoc,
      envelope: input.envelope,
      logRef: input.logRef,
      logEntry: input.logEntry,
      waiverFlagged: input.waiverFlagged,
      objectRef: input.objectRef ?? null,
      createdAt: new Date(),
    };
    this.records.push(record);
    return Promise.resolve(record);
  }

  findByArtifact(artifactId: string): Promise<ReleaseDocRecord | null> {
    return Promise.resolve(
      this.records.find((r) => r.artifactId === artifactId) ?? null,
    );
  }
}
