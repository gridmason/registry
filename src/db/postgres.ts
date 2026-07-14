/**
 * Postgres access.
 *
 * A thin wrapper over a `pg` connection pool: parameterised queries, a
 * checked-out client for transactional work (the migration runner leans on
 * this), a `ping` for the readiness probe, and graceful `close`. Records, the
 * review queue, and the audit log live here; bundles and feeds live in the
 * object store.
 */
import pg from 'pg';

import type { PostgresConfig } from '../config/index.js';
import type { MigrationClient } from './migrate.js';

const { Pool } = pg;

export interface Postgres {
  /** Run a parameterised query against a pooled connection. */
  query(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
  /**
   * Check out one dedicated connection for the duration of `fn` (transactions,
   * migrations) and release it afterwards, even on error.
   */
  withClient<T>(fn: (client: MigrationClient) => Promise<T>): Promise<T>;
  /** Verify connectivity; throws if the database is unreachable. */
  ping(): Promise<void>;
  /** Drain and close the pool. */
  close(): Promise<void>;
}

/** Build a {@link Postgres} handle from configuration. */
export function createPostgres(config: PostgresConfig): Postgres {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
  });

  return {
    query: (sql, params) => pool.query(sql, params),

    async withClient(fn) {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    close: () => pool.end(),
  };
}
