/**
 * ReviewCase persistence over the `review_case` table (migration 0001).
 *
 * A review case is the record the review lane acts on: it carries the automated
 * `checksReport` (the shared `@gridmason/cli/checks` output, SPEC §4) against an
 * artifact, and gains the human verdict/findings when a reviewer decides it
 * (FR-4, #9). Like the other stores, the service depends on the
 * {@link ReviewCaseStore} interface, not on `pg`:
 * {@link createPostgresReviewCaseStore} backs production while
 * {@link InMemoryReviewCaseStore} backs tests.
 */
import type { Postgres } from '../db/postgres.js';
import type { AutomatedReviewReport } from './report.js';
import type { ReviewFinding, Verdict } from './human/types.js';

export interface CreateReviewCaseInput {
  readonly artifactId: string;
  /** The automated-checks report to persist as `checks_report`. */
  readonly checksReport: AutomatedReviewReport;
  /**
   * Whether this case is a publisher **appeal** re-opening a rejected artifact
   * (SPEC §4). Defaults to `false` — the automated stage opens first-pass cases.
   */
  readonly isAppeal?: boolean;
  /**
   * On an appeal, the identity (composite form) of the reviewer who cast the
   * original rejection, so the human lane refuses a verdict from them (appeal
   * reviewer ≠ original reviewer). `null`/omitted when there is no reviewer to
   * exclude (a first-pass case, or an appeal of an automated `system` rejection).
   */
  readonly excludedReviewer?: string | null;
}

/** The human verdict recorded on a review case by {@link ReviewCaseStore.recordVerdict}. */
export interface RecordVerdictInput {
  readonly caseId: string;
  /** The reviewer's identity in `composeOidcIdentity` composite form. */
  readonly reviewer: string;
  readonly verdict: Verdict;
  /** Findings, each referencing a report check id (or `manual`) — FR-4. */
  readonly findings: readonly ReviewFinding[];
  /** Whether this verdict rode the disclosed flagship self-review waiver (SPEC §4a). */
  readonly waiverUsed: boolean;
}

/**
 * A stored review case: the automated-stage slice (`checksReport`) plus the human
 * verdict fields, which are `null`/`false` until a reviewer decides it (#9).
 */
export interface ReviewCaseRecord {
  readonly id: string;
  readonly artifactId: string;
  readonly checksReport: AutomatedReviewReport;
  /** Reviewer identity (composite), or `null` while the case is pending. */
  readonly reviewer: string | null;
  /** The verdict, or `null` while the case is pending. */
  readonly verdict: Verdict | null;
  /** Recorded findings, or `null` while the case is pending. */
  readonly findings: readonly ReviewFinding[] | null;
  /** Whether the flagship self-review waiver was used to permit the verdict. */
  readonly waiverUsed: boolean;
  /** Whether this case is a publisher appeal re-review (SPEC §4). */
  readonly isAppeal: boolean;
  /**
   * The reviewer identity (composite) this appeal case may **not** be decided by
   * — the original rejection's reviewer. `null` on a first-pass case or when the
   * original rejection had no human reviewer (automated `system` rejection).
   */
  readonly excludedReviewer: string | null;
  readonly createdAt: Date;
  /** When the verdict was recorded, or `null` while the case is pending. */
  readonly decidedAt: Date | null;
}

export interface ReviewCaseStore {
  /** Open a review case for an artifact with its automated-checks report. */
  create(input: CreateReviewCaseInput): Promise<ReviewCaseRecord>;
  /** A review case by its id, or `null` if none exists. */
  findById(id: string): Promise<ReviewCaseRecord | null>;
  /** The most recent review case for an artifact, or `null` if none exists. */
  findByArtifact(artifactId: string): Promise<ReviewCaseRecord | null>;
  /**
   * Record a reviewer's verdict on a pending case. The update is guarded on the
   * verdict still being `null`, so a second verdict for the same case is a no-op
   * (`null` result) — the first reviewer to decide wins, and a race cannot
   * overwrite a recorded verdict. Returns the decided record, or `null` when the
   * case does not exist or has already been decided.
   */
  recordVerdict(input: RecordVerdictInput): Promise<ReviewCaseRecord | null>;
}

interface ReviewCaseRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly checks_report: AutomatedReviewReport;
  readonly reviewer: string | null;
  readonly verdict: Verdict | null;
  readonly findings: readonly ReviewFinding[] | null;
  readonly waiver_used: boolean;
  readonly is_appeal: boolean;
  readonly excluded_reviewer: string | null;
  readonly created_at: Date;
  readonly decided_at: Date | null;
}

function rowToRecord(row: ReviewCaseRow): ReviewCaseRecord {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    checksReport: row.checks_report,
    reviewer: row.reviewer,
    verdict: row.verdict,
    findings: row.findings,
    waiverUsed: row.waiver_used,
    isAppeal: row.is_appeal,
    excludedReviewer: row.excluded_reviewer,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

const SELECT_COLUMNS =
  'id, artifact_id, checks_report, reviewer, verdict, findings, waiver_used, is_appeal, excluded_reviewer, created_at, decided_at';

export function createPostgresReviewCaseStore(postgres: Postgres): ReviewCaseStore {
  return {
    async create(input) {
      // `checks_report` is jsonb; node-pg serialises the report object to JSON.
      // `is_appeal`/`excluded_reviewer` default to a first-pass case; an appeal
      // (src/review/appeal) passes them to route the second-reviewer rule.
      const { rows } = await postgres.query(
        `INSERT INTO review_case (artifact_id, checks_report, is_appeal, excluded_reviewer)
           VALUES ($1, $2, $3, $4)
           RETURNING ${SELECT_COLUMNS}`,
        [input.artifactId, input.checksReport, input.isAppeal ?? false, input.excludedReviewer ?? null],
      );
      return rowToRecord(rows[0] as ReviewCaseRow);
    },

    async findById(id) {
      const { rows } = await postgres.query(
        `SELECT ${SELECT_COLUMNS} FROM review_case WHERE id = $1`,
        [id],
      );
      return rows[0] ? rowToRecord(rows[0] as ReviewCaseRow) : null;
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

    async recordVerdict(input) {
      // `WHERE verdict IS NULL` makes the write a no-op (null result) once any
      // verdict has landed, so two reviewers deciding the same case cannot both
      // win — the second update matches no row. `findings` is jsonb; node-pg
      // serialises the array to JSON.
      const { rows } = await postgres.query(
        `UPDATE review_case
            SET reviewer = $2, verdict = $3, findings = $4,
                waiver_used = $5, decided_at = now()
          WHERE id = $1 AND verdict IS NULL
          RETURNING ${SELECT_COLUMNS}`,
        [input.caseId, input.reviewer, input.verdict, input.findings, input.waiverUsed],
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
      reviewer: null,
      verdict: null,
      findings: null,
      waiverUsed: false,
      isAppeal: input.isAppeal ?? false,
      excludedReviewer: input.excludedReviewer ?? null,
      createdAt: new Date(),
      decidedAt: null,
    };
    this.records.push(record);
    return Promise.resolve(record);
  }

  findById(id: string): Promise<ReviewCaseRecord | null> {
    return Promise.resolve(this.records.find((r) => r.id === id) ?? null);
  }

  findByArtifact(artifactId: string): Promise<ReviewCaseRecord | null> {
    // The most recently created case wins, matching the Postgres ordering.
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i]!;
      if (record.artifactId === artifactId) return Promise.resolve(record);
    }
    return Promise.resolve(null);
  }

  recordVerdict(input: RecordVerdictInput): Promise<ReviewCaseRecord | null> {
    const index = this.records.findIndex((r) => r.id === input.caseId);
    if (index === -1) return Promise.resolve(null);
    const current = this.records[index]!;
    // Mirror the Postgres `verdict IS NULL` guard: a decided case is never re-decided.
    if (current.verdict !== null) return Promise.resolve(null);
    const decided: ReviewCaseRecord = {
      ...current,
      reviewer: input.reviewer,
      verdict: input.verdict,
      findings: input.findings,
      waiverUsed: input.waiverUsed,
      decidedAt: new Date(),
    };
    this.records[index] = decided;
    return Promise.resolve(decided);
  }
}
