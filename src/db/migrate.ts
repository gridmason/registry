/**
 * Migration runner.
 *
 * Applies the ordered {@link migrations} that have not yet been recorded in the
 * `schema_migrations` bookkeeping table, each inside its own transaction. Idempotent
 * at two levels: the runner skips already-applied ids, and every migration's DDL
 * is itself `IF NOT EXISTS`-guarded, so a re-run — or a run against a
 * partially-migrated database — converges without error.
 *
 * The runner talks to a minimal {@link MigrationClient} (one dedicated
 * connection with a `query` method), which the real `pg` `PoolClient` satisfies
 * and a test fake can emulate without a live database.
 */
import { migrations as defaultMigrations, type Migration } from './migrations/index.js';

/** A single dedicated database connection the runner issues statements on. */
export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Optional structured-logging hook; one line per applied migration. */
export interface MigrationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

const BOOKKEEPING_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         text        PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** Ids already recorded in `schema_migrations`, oldest first. */
async function appliedIds(client: MigrationClient): Promise<Set<string>> {
  const { rows } = await client.query('SELECT id FROM schema_migrations');
  return new Set(rows.map((row) => String(row.id)));
}

/**
 * Apply every pending migration in order. Returns the ids that were applied by
 * this call (empty when the database was already up to date).
 *
 * @param client   a single dedicated connection (e.g. a checked-out `PoolClient`)
 * @param options  migration list + logger overrides (defaults suit production)
 */
export async function runMigrations(
  client: MigrationClient,
  options: { migrations?: readonly Migration[]; logger?: MigrationLogger } = {},
): Promise<string[]> {
  const list = options.migrations ?? defaultMigrations;
  const logger = options.logger;

  await client.query(BOOKKEEPING_DDL);
  const already = await appliedIds(client);

  const applied: string[] = [];
  for (const migration of list) {
    if (already.has(migration.id)) continue;

    await client.query('BEGIN');
    try {
      await client.query(migration.up);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    applied.push(migration.id);
    logger?.info({ migration: migration.id }, 'applied migration');
  }

  if (applied.length === 0) {
    logger?.info({ migrations: list.length }, 'database schema up to date');
  }
  return applied;
}

/** The ids of migrations not yet recorded as applied, in order. */
export async function pendingMigrations(
  client: MigrationClient,
  list: readonly Migration[] = defaultMigrations,
): Promise<string[]> {
  await client.query(BOOKKEEPING_DDL);
  const already = await appliedIds(client);
  return list.filter((migration) => !already.has(migration.id)).map((m) => m.id);
}
