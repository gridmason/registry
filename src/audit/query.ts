/**
 * Audit-log read side (SPEC §10, FR-12).
 *
 * The {@link import('./index.js').AuditSink} write path records every state
 * transition; this is the query seam an operator or auditor reads them back
 * through. Every emitted event is durable in the `audit_event` table, and the
 * completeness guarantee (FR-12) is only useful if the trail can be retrieved —
 * so this store exposes filtering by subject, action, and time range with
 * keyset pagination, and the HTTP surface (`src/http/audit.ts`) gates it on the
 * operator set.
 *
 * The service depends on the {@link AuditQueryStore} interface, not on `pg`:
 * {@link createPostgresAuditQueryStore} backs production while
 * {@link InMemoryAuditStore} backs tests (and doubles as an
 * {@link import('./index.js').AuditSink} so a test can emit through the pipeline
 * and read the events back).
 */
import type { Postgres } from '../db/postgres.js';
import type { AuditEvent, AuditSink } from './index.js';

/** A stored audit event: the emitted {@link AuditEvent} plus its durable id. */
export interface AuditEventRecord extends AuditEvent {
  /** The monotonic row id (also the pagination cursor). */
  readonly id: number;
}

/** Filters + paging for an audit-log query. All filters are optional (AND-combined). */
export interface AuditQuery {
  /** Match events whose subject equals this exactly. */
  readonly subject?: string;
  /** Match events whose action equals this exactly. */
  readonly action?: string;
  /** Only events at or after this instant (inclusive). */
  readonly since?: Date;
  /** Only events at or before this instant (inclusive). */
  readonly until?: Date;
  /**
   * Keyset cursor: return only events with an id strictly less than this. The
   * result is newest-first, so paging forward means passing the last id seen.
   */
  readonly before?: number;
  /** Maximum events to return. The store clamps to {@link AUDIT_QUERY_MAX_LIMIT}. */
  readonly limit?: number;
}

/** A page of audit events, newest first, plus the cursor for the next page. */
export interface AuditQueryPage {
  readonly events: readonly AuditEventRecord[];
  /**
   * The `before` cursor to pass for the next (older) page, or `null` when this
   * page reached the end. Set only when a full `limit`-sized page was returned.
   */
  readonly nextBefore: number | null;
}

/** The default page size when a query does not set one. */
export const AUDIT_QUERY_DEFAULT_LIMIT = 50;
/** The hard cap on a page size — a caller cannot ask for more than this. */
export const AUDIT_QUERY_MAX_LIMIT = 500;

/** Clamp a requested limit into `[1, AUDIT_QUERY_MAX_LIMIT]`, defaulting when unset. */
export function clampAuditLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return AUDIT_QUERY_DEFAULT_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > AUDIT_QUERY_MAX_LIMIT) return AUDIT_QUERY_MAX_LIMIT;
  return floored;
}

/** The audit-log read side. */
export interface AuditQueryStore {
  /** Read a page of audit events matching `query`, newest first. */
  query(query: AuditQuery): Promise<AuditQueryPage>;
}

interface AuditEventRow {
  readonly id: string | number;
  readonly actor: string;
  readonly action: string;
  readonly subject: string;
  readonly at: Date;
}

function rowToRecord(row: AuditEventRow): AuditEventRecord {
  return {
    // `bigint` columns arrive as strings from `pg`; normalise to a number (the id
    // space is far below Number.MAX_SAFE_INTEGER for any real registry).
    id: typeof row.id === 'string' ? Number(row.id) : row.id,
    actor: row.actor,
    action: row.action,
    subject: row.subject,
    at: row.at,
  };
}

/** Build a page result, computing the keyset cursor from the returned rows. */
function toPage(events: AuditEventRecord[], limit: number): AuditQueryPage {
  // A cursor is only meaningful when the page was full — a short page is the end
  // of the stream, so there is nothing older to fetch.
  const nextBefore =
    events.length === limit && events.length > 0 ? events[events.length - 1]!.id : null;
  return { events, nextBefore };
}

export function createPostgresAuditQueryStore(postgres: Postgres): AuditQueryStore {
  return {
    async query(query) {
      const limit = clampAuditLimit(query.limit);
      const conditions: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown): void => {
        params.push(value);
        conditions.push(clause.replace('?', `$${params.length}`));
      };
      if (query.subject !== undefined) add('subject = ?', query.subject);
      if (query.action !== undefined) add('action = ?', query.action);
      if (query.since !== undefined) add('at >= ?', query.since);
      if (query.until !== undefined) add('at <= ?', query.until);
      if (query.before !== undefined) add('id < ?', query.before);

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);
      const { rows } = await postgres.query(
        `SELECT id, actor, action, subject, at
           FROM audit_event
           ${where}
          ORDER BY id DESC
          LIMIT $${params.length}`,
        params,
      );
      const events = (rows as AuditEventRow[]).map(rowToRecord);
      return toPage(events, limit);
    },
  };
}

/**
 * In-memory audit store for tests. It is both an {@link AuditSink} (so a test can
 * install it via `setAuditSink` and drive real transitions through it) and an
 * {@link AuditQueryStore} (so the same test reads the recorded events back through
 * the query endpoint) — the two halves of FR-12 over one collection.
 */
export class InMemoryAuditStore implements AuditSink, AuditQueryStore {
  private readonly records: AuditEventRecord[] = [];
  private counter = 0;

  emit(event: AuditEvent): void {
    this.records.push({ ...event, id: ++this.counter });
  }

  /** Every recorded event, in insertion order (oldest first). Test convenience. */
  all(): readonly AuditEventRecord[] {
    return this.records;
  }

  query(query: AuditQuery): Promise<AuditQueryPage> {
    const limit = clampAuditLimit(query.limit);
    const matched = this.records
      .filter((event) => {
        if (query.subject !== undefined && event.subject !== query.subject) return false;
        if (query.action !== undefined && event.action !== query.action) return false;
        if (query.since !== undefined && event.at.getTime() < query.since.getTime()) return false;
        if (query.until !== undefined && event.at.getTime() > query.until.getTime()) return false;
        if (query.before !== undefined && event.id >= query.before) return false;
        return true;
      })
      // Newest first, matching the Postgres `ORDER BY id DESC`.
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return Promise.resolve(toPage(matched, limit));
  }
}
