/**
 * Publisher persistence over the `publisher` table.
 *
 * The service depends on the {@link PublisherStore} interface, not on `pg`
 * directly: {@link createPostgresPublisherStore} backs production and the dev
 * compose, while {@link InMemoryPublisherStore} backs tests and lets the API run
 * without a live database (matching the object-store pattern).
 *
 * Uniqueness is enforced at the schema level (per-registry unique indexes on
 * `prefix` and `oidc_identity`, migration 0001) and surfaced here as a typed
 * {@link PublisherConflict} so the route can answer a clean 409 instead of a raw
 * driver error.
 */
import type { Postgres } from '../db/postgres.js';
import type { Logger } from '../logging/index.js';
import {
  composeOidcIdentity,
  type PublisherRecord,
  type PublisherTier,
} from './types.js';

export interface RegisterPublisherInput {
  readonly issuer: string;
  readonly subject: string;
  readonly prefix: string;
  readonly tier: PublisherTier;
}

/** Which uniqueness invariant a registration hit. */
export type PublisherConflict = 'prefix' | 'identity';

export type RegisterPublisherResult =
  | { readonly ok: true; readonly record: PublisherRecord }
  | { readonly ok: false; readonly conflict: PublisherConflict };

export interface PublisherStore {
  /**
   * Register a publisher and claim its prefix in one insert. The prefix and the
   * `(issuer, subject)` identity are each unique within the registry; a
   * collision resolves to a typed {@link PublisherConflict} rather than throwing.
   */
  register(input: RegisterPublisherInput): Promise<RegisterPublisherResult>;
  findById(id: string): Promise<PublisherRecord | null>;
  findByPrefix(prefix: string): Promise<PublisherRecord | null>;
  findByIdentity(issuer: string, subject: string): Promise<PublisherRecord | null>;
}

interface PublisherRow {
  readonly id: string;
  readonly oidc_issuer: string;
  readonly oidc_subject: string;
  readonly prefix: string;
  readonly tier: string;
  readonly created_at: Date;
}

function rowToRecord(row: PublisherRow): PublisherRecord {
  return {
    id: row.id,
    issuer: row.oidc_issuer,
    subject: row.oidc_subject,
    prefix: row.prefix,
    // The DB check constraint guarantees the tier is one of the three values.
    tier: row.tier as PublisherTier,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS =
  'id, oidc_issuer, oidc_subject, prefix, tier, created_at';

// The unique constraints (index names, migration 0001) whose violation maps to
// a typed conflict. Classification is by the *exact* constraint name, never a
// substring guess, so a violation of any other unique constraint added later is
// not silently mislabeled as one of these.
const PREFIX_CONSTRAINT = 'publisher_prefix_key';
const IDENTITY_CONSTRAINT = 'publisher_oidc_identity_key';

/**
 * Map a Postgres unique-violation (SQLSTATE 23505) to the invariant it broke.
 * An unrecognised constraint returns `null`: the raw error then propagates (a
 * 500) rather than being reported as a false `prefix`/`identity` conflict, and
 * the constraint is logged so the unhandled case is visible.
 */
function conflictOf(err: unknown, logger?: Logger): PublisherConflict | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, constraint } = err as { code?: string; constraint?: string };
  if (code !== '23505') return null;
  switch (constraint) {
    case PREFIX_CONSTRAINT:
      return 'prefix';
    case IDENTITY_CONSTRAINT:
      return 'identity';
    default:
      logger?.warn(
        { code, constraint },
        'unclassified unique violation on publisher insert; surfacing as 500',
      );
      return null;
  }
}

export function createPostgresPublisherStore(
  postgres: Postgres,
  logger?: Logger,
): PublisherStore {
  return {
    async register(input) {
      const identity = composeOidcIdentity(input.issuer, input.subject);
      try {
        const { rows } = await postgres.query(
          `INSERT INTO publisher (oidc_identity, oidc_issuer, oidc_subject, prefix, tier)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${SELECT_COLUMNS}`,
          [identity, input.issuer, input.subject, input.prefix, input.tier],
        );
        return { ok: true, record: rowToRecord(rows[0] as PublisherRow) };
      } catch (err) {
        const conflict = conflictOf(err, logger);
        if (conflict) return { ok: false, conflict };
        throw err;
      }
    },

    async findById(id) {
      const { rows } = await postgres.query(
        `SELECT ${SELECT_COLUMNS} FROM publisher WHERE id = $1`,
        [id],
      );
      return rows[0] ? rowToRecord(rows[0] as PublisherRow) : null;
    },

    async findByPrefix(prefix) {
      const { rows } = await postgres.query(
        `SELECT ${SELECT_COLUMNS} FROM publisher WHERE prefix = $1`,
        [prefix],
      );
      return rows[0] ? rowToRecord(rows[0] as PublisherRow) : null;
    },

    async findByIdentity(issuer, subject) {
      const { rows } = await postgres.query(
        `SELECT ${SELECT_COLUMNS} FROM publisher WHERE oidc_issuer = $1 AND oidc_subject = $2`,
        [issuer, subject],
      );
      return rows[0] ? rowToRecord(rows[0] as PublisherRow) : null;
    },
  };
}

/**
 * In-memory {@link PublisherStore}. Backs tests and lets the API run without a
 * live database; never for production (nothing is durable or shared).
 */
export class InMemoryPublisherStore implements PublisherStore {
  private readonly records: PublisherRecord[] = [];
  private counter = 0;

  register(input: RegisterPublisherInput): Promise<RegisterPublisherResult> {
    if (this.records.some((r) => r.prefix === input.prefix)) {
      return Promise.resolve({ ok: false, conflict: 'prefix' });
    }
    if (
      this.records.some(
        (r) => r.issuer === input.issuer && r.subject === input.subject,
      )
    ) {
      return Promise.resolve({ ok: false, conflict: 'identity' });
    }
    const record: PublisherRecord = {
      id: `pub-${++this.counter}`,
      issuer: input.issuer,
      subject: input.subject,
      prefix: input.prefix,
      tier: input.tier,
      createdAt: new Date(),
    };
    this.records.push(record);
    return Promise.resolve({ ok: true, record });
  }

  findById(id: string): Promise<PublisherRecord | null> {
    return Promise.resolve(this.records.find((r) => r.id === id) ?? null);
  }

  findByPrefix(prefix: string): Promise<PublisherRecord | null> {
    return Promise.resolve(this.records.find((r) => r.prefix === prefix) ?? null);
  }

  findByIdentity(issuer: string, subject: string): Promise<PublisherRecord | null> {
    return Promise.resolve(
      this.records.find((r) => r.issuer === issuer && r.subject === subject) ?? null,
    );
  }
}
