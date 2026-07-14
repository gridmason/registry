/**
 * FeedEntry persistence over the `feed_entry` table (migration 0001).
 *
 * A `FeedEntry` is one distribution-state transition the registry publishes to
 * its signed revocation & kill feed (SPEC §6, FR-8): an artifact was `revoked`
 * (block new loads) or `killed` (block + force-unload), with an advisory
 * `severity` and a human `reason`. The `seq` is assigned by the database
 * (`GENERATED ALWAYS AS IDENTITY`, migration 0001) so it is **monotonic across
 * the whole registry** — the single per-registry cursor a host tracks
 * ({@link import('@gridmason/protocol').Cursor}). The service never picks a seq;
 * the store returns the one the DB minted.
 *
 * Like the other stores the service depends on the {@link FeedEntryStore}
 * interface, not on `pg`: {@link createPostgresFeedEntryStore} backs production
 * while {@link InMemoryFeedEntryStore} backs tests.
 *
 * The **feed** the registry serves is not the raw row log: it is a
 * {@link FeedSnapshot} — the *latest* entry per artifact that is still revoked or
 * killed (an artifact only ever moves toward more severe: approved → revoked →
 * killed, never back), plus the highest seq the registry has issued as the feed's
 * monotonic version. `snapshot` computes exactly that.
 */
import type { RevocationEntry, RevocationSeverity } from '@gridmason/protocol';

import type { Postgres } from '../db/postgres.js';

/**
 * The distribution states this cut publishes to the feed. The `feed_entry` table
 * also permits `published`, but only revoke/kill transitions are emitted here —
 * a `published` entry would be an approval-time record, out of scope (FR-8).
 */
export type FeedTransitionState = RevocationEntry['state']; // 'revoked' | 'killed'

/** A distribution-state transition to append to the feed. */
export interface AppendFeedEntryInput {
  /** The `artifact` table id (uuid) this entry acts on (FK). */
  readonly artifactId: string;
  /**
   * The artifact's wire id — publisher-prefixed, version-qualified (`tag@version`),
   * the exact string a host matches against the ids it is about to load. The
   * Postgres store re-derives this from the joined artifact row at read time; it
   * is carried here so the in-memory store (which holds no artifact rows) can
   * reproduce the same snapshot.
   */
  readonly artifact: string;
  readonly state: FeedTransitionState;
  readonly severity: RevocationSeverity;
  readonly reason: string;
}

/** A persisted feed entry, with the DB-minted monotonic `seq`. */
export interface FeedEntryRecord {
  readonly seq: number;
  readonly artifactId: string;
  readonly state: FeedTransitionState;
  readonly severity: RevocationSeverity;
  readonly reason: string;
  readonly issuedAt: Date;
}

/** One artifact currently revoked/killed, resolved to its wire id (`tag@version`). */
export interface FeedSnapshotEntry {
  readonly seq: number;
  /** Publisher-prefixed, version-qualified artifact id (`tag@version`). */
  readonly artifact: string;
  readonly state: FeedTransitionState;
  readonly severity: RevocationSeverity;
  readonly reason: string;
}

/**
 * The feed's data at a moment: its monotonic version (`seq`) and the artifacts a
 * host must block. `seq` is the highest entry seq the registry has issued (`0`
 * when it has issued none — a valid "nothing revoked" feed, which a host's `-1`
 * cursor still accepts). `entries` is the latest revoked/killed entry per
 * artifact, in seq order.
 */
export interface FeedSnapshot {
  readonly seq: number;
  readonly entries: readonly FeedSnapshotEntry[];
}

export interface FeedEntryStore {
  /**
   * Append a distribution-state transition, returning it with the monotonic `seq`
   * the database assigned. The seq is strictly greater than every prior entry's,
   * so a fresh append always advances the served feed's version.
   */
  append(input: AppendFeedEntryInput): Promise<FeedEntryRecord>;
  /** The current feed snapshot: monotonic version + the artifacts to block. */
  snapshot(): Promise<FeedSnapshot>;
}

interface FeedEntryRow {
  readonly seq: string; // bigint arrives as a string from `pg`
  readonly artifact_id: string;
  readonly state: string;
  readonly severity: string;
  readonly reason: string;
  readonly issued_at: Date;
}

function rowToRecord(row: FeedEntryRow): FeedEntryRecord {
  return {
    seq: Number(row.seq),
    artifactId: row.artifact_id,
    // The DB check constraint guarantees the state; this cut only writes revoke/kill.
    state: row.state as FeedTransitionState,
    severity: row.severity as RevocationSeverity,
    reason: row.reason,
    issuedAt: row.issued_at,
  };
}

export function createPostgresFeedEntryStore(postgres: Postgres): FeedEntryStore {
  return {
    async append(input) {
      const { rows } = await postgres.query(
        `INSERT INTO feed_entry (artifact_id, state, severity, reason)
         VALUES ($1, $2, $3, $4)
         RETURNING seq, artifact_id, state, severity, reason, issued_at`,
        [input.artifactId, input.state, input.severity, input.reason],
      );
      return rowToRecord(rows[0] as FeedEntryRow);
    },

    async snapshot() {
      // Latest entry per artifact (DISTINCT ON + seq DESC), joined to the artifact
      // for its wire id; kept only when that latest state still blocks loading
      // (revoked/killed). The feed's `seq` is the global max entry seq so any
      // append — even to an already-listed artifact — advances the version.
      const { rows } = await postgres.query(
        `SELECT latest.seq, latest.state, latest.severity, latest.reason,
                a.tag, a.version
           FROM (
             SELECT DISTINCT ON (fe.artifact_id)
                    fe.artifact_id, fe.seq, fe.state, fe.severity, fe.reason
               FROM feed_entry fe
              ORDER BY fe.artifact_id, fe.seq DESC
           ) latest
           JOIN artifact a ON a.id = latest.artifact_id
          WHERE latest.state IN ('revoked', 'killed')
          ORDER BY latest.seq ASC`,
      );
      const entries: FeedSnapshotEntry[] = rows.map((raw) => {
        const row = raw as {
          seq: string;
          state: string;
          severity: string;
          reason: string;
          tag: string;
          version: string;
        };
        return {
          seq: Number(row.seq),
          artifact: `${row.tag}@${row.version}`,
          state: row.state as FeedTransitionState,
          severity: row.severity as RevocationSeverity,
          reason: row.reason,
        };
      });
      const maxResult = await postgres.query(
        'SELECT COALESCE(MAX(seq), 0) AS seq FROM feed_entry',
      );
      const seq = Number((maxResult.rows[0] as { seq: string }).seq);
      return { seq, entries };
    },
  };
}

/**
 * In-memory {@link FeedEntryStore}. Backs tests and lets the revocation surface
 * run without a live database; never for production (nothing is durable). It
 * mirrors the Postgres seq (`GENERATED ALWAYS AS IDENTITY` starts at 1) with a
 * counter so a host cursor behaves identically against either store.
 */
export class InMemoryFeedEntryStore implements FeedEntryStore {
  private readonly rows: (FeedEntryRecord & { readonly artifact: string })[] = [];
  private seqCounter = 0;

  append(input: AppendFeedEntryInput): Promise<FeedEntryRecord> {
    const record: FeedEntryRecord = {
      seq: ++this.seqCounter,
      artifactId: input.artifactId,
      state: input.state,
      severity: input.severity,
      reason: input.reason,
      issuedAt: new Date(),
    };
    this.rows.push({ ...record, artifact: input.artifact });
    return Promise.resolve(record);
  }

  snapshot(): Promise<FeedSnapshot> {
    // Highest-seq row per artifact id (rows are append-ordered, so the last match
    // wins), then keep only those still revoked/killed, in seq order.
    const latest = new Map<string, (typeof this.rows)[number]>();
    for (const row of this.rows) latest.set(row.artifactId, row);
    const entries: FeedSnapshotEntry[] = [...latest.values()]
      .filter((row) => row.state === 'revoked' || row.state === 'killed')
      .sort((a, b) => a.seq - b.seq)
      .map((row) => ({
        seq: row.seq,
        artifact: row.artifact,
        state: row.state,
        severity: row.severity,
        reason: row.reason,
      }));
    return Promise.resolve({ seq: this.seqCounter, entries });
  }
}
