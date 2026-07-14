/**
 * ReviewCase persistence over the `review_case` table (migration 0001).
 *
 * A review case is the record the review lane acts on: it carries the automated
 * `checksReport` (the shared `@gridmason/cli/checks` output, SPEC §4) against an
 * artifact, and later gains the human verdict/findings (next issue). Like the
 * other stores, the service depends on the {@link ReviewCaseStore} interface, not
 * on `pg`: {@link createPostgresReviewCaseStore} backs production while
 * {@link InMemoryReviewCaseStore} backs tests.
 */
import type { Postgres } from '../db/postgres.js';
import type { AutomatedReviewReport } from './report.js';

export interface CreateReviewCaseInput {
  readonly artifactId: string;
  /** The automated-checks report to persist as `checks_report`. */
  readonly checksReport: AutomatedReviewReport;
}

/** A stored review case (the automated-stage slice; verdict fields land later). */
export interface ReviewCaseRecord {
  readonly id: string;
  readonly artifactId: string;
  readonly checksReport: AutomatedReviewReport;
  readonly createdAt: Date;
}

export interface ReviewCaseStore {
  /** Open a review case for an artifact with its automated-checks report. */
  create(input: CreateReviewCaseInput): Promise<ReviewCaseRecord>;
  /** The most recent review case for an artifact, or `null` if none exists. */
  findByArtifact(artifactId: string): Promise<ReviewCaseRecord | null>;
}

interface ReviewCaseRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly checks_report: AutomatedReviewReport;
  readonly created_at: Date;
}

function rowToRecord(row: ReviewCaseRow): ReviewCaseRecord {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    checksReport: row.checks_report,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = 'id, artifact_id, checks_report, created_at';

export function createPostgresReviewCaseStore(postgres: Postgres): ReviewCaseStore {
  return {
    async create(input) {
      // `checks_report` is jsonb; node-pg serialises the report object to JSON.
      const { rows } = await postgres.query(
        `INSERT INTO review_case (artifact_id, checks_report)
           VALUES ($1, $2)
           RETURNING ${SELECT_COLUMNS}`,
        [input.artifactId, input.checksReport],
      );
      return rowToRecord(rows[0] as ReviewCaseRow);
    },

    async findByArtifact(artifactId) {
      const { rows } = await postgres.query(
        `SELECT ${SELECT_COLUMNS}
           FROM review_case
          WHERE artifact_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [artifactId],
      );
      return rows[0] ? rowToRecord(rows[0] as ReviewCaseRow) : null;
    },
  };
}

/**
 * In-memory {@link ReviewCaseStore}. Backs tests and lets the review stage run
 * without a live database; never for production (nothing is durable or shared).
 */
export class InMemoryReviewCaseStore implements ReviewCaseStore {
  private readonly records: ReviewCaseRecord[] = [];
  private counter = 0;

  create(input: CreateReviewCaseInput): Promise<ReviewCaseRecord> {
    const record: ReviewCaseRecord = {
      id: `rc-${++this.counter}`,
      artifactId: input.artifactId,
      checksReport: input.checksReport,
      createdAt: new Date(),
    };
    this.records.push(record);
    return Promise.resolve(record);
  }

  findByArtifact(artifactId: string): Promise<ReviewCaseRecord | null> {
    // The most recently created case wins, matching the Postgres ordering.
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i]!;
      if (record.artifactId === artifactId) return Promise.resolve(record);
    }
    return Promise.resolve(null);
  }
}
