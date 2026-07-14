import { describe, expect, it } from 'vitest';

import {
  pendingMigrations,
  runMigrations,
  type MigrationClient,
} from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations/index.js';
import type { Migration } from '../src/db/migrations/types.js';

/**
 * A fake connection that emulates just enough Postgres for the runner: the
 * `schema_migrations` bookkeeping table (as a Set) and transaction framing. A
 * migration whose SQL contains `-- FAIL` throws when executed, so rollback
 * behaviour can be exercised without a live database.
 */
class FakeClient implements MigrationClient {
  readonly log: string[] = [];
  private readonly applied = new Set<string>();
  private pendingInserts: string[] = [];

  constructor(preApplied: string[] = []) {
    for (const id of preApplied) this.applied.add(id);
  }

  appliedIds(): string[] {
    return [...this.applied];
  }

  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    const s = sql.trim();
    const head = s.split('\n')[0] ?? s;
    this.log.push(head);

    if (head.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      return Promise.resolve({ rows: [] });
    }
    if (head.startsWith('SELECT id FROM schema_migrations')) {
      return Promise.resolve({ rows: [...this.applied].map((id) => ({ id })) });
    }
    if (s === 'BEGIN') {
      this.pendingInserts = [];
      return Promise.resolve({ rows: [] });
    }
    if (s === 'COMMIT') {
      for (const id of this.pendingInserts) this.applied.add(id);
      this.pendingInserts = [];
      return Promise.resolve({ rows: [] });
    }
    if (s === 'ROLLBACK') {
      this.pendingInserts = [];
      return Promise.resolve({ rows: [] });
    }
    if (head.startsWith('INSERT INTO schema_migrations')) {
      this.pendingInserts.push(String(params?.[0]));
      return Promise.resolve({ rows: [] });
    }
    // Otherwise it is a migration's DDL body.
    if (s.includes('-- FAIL')) {
      return Promise.reject(new Error('boom'));
    }
    return Promise.resolve({ rows: [] });
  }
}

const twoMigrations: Migration[] = [
  { id: '0001_a', up: 'CREATE TABLE IF NOT EXISTS a ();' },
  { id: '0002_b', up: 'CREATE TABLE IF NOT EXISTS b ();' },
];

describe('runMigrations', () => {
  it('applies every pending migration in order on a fresh database', async () => {
    const client = new FakeClient();
    const applied = await runMigrations(client, { migrations: twoMigrations });
    expect(applied).toEqual(['0001_a', '0002_b']);
    expect(client.appliedIds()).toEqual(['0001_a', '0002_b']);
  });

  it('is idempotent — a second run applies nothing', async () => {
    const client = new FakeClient();
    await runMigrations(client, { migrations: twoMigrations });
    const second = await runMigrations(client, { migrations: twoMigrations });
    expect(second).toEqual([]);
    expect(client.appliedIds()).toEqual(['0001_a', '0002_b']);
  });

  it('skips already-applied migrations and applies only the new one', async () => {
    const client = new FakeClient(['0001_a']);
    const applied = await runMigrations(client, { migrations: twoMigrations });
    expect(applied).toEqual(['0002_b']);
  });

  it('wraps each migration in BEGIN/COMMIT', async () => {
    const client = new FakeClient();
    await runMigrations(client, { migrations: [twoMigrations[0]!] });
    expect(client.log).toContain('BEGIN');
    expect(client.log).toContain('COMMIT');
    expect(client.log).not.toContain('ROLLBACK');
  });

  it('rolls back and rethrows when a migration fails, recording nothing', async () => {
    const client = new FakeClient();
    const failing: Migration[] = [{ id: '0001_bad', up: '-- FAIL\nSELECT 1;' }];
    await expect(runMigrations(client, { migrations: failing })).rejects.toThrow('boom');
    expect(client.log).toContain('ROLLBACK');
    expect(client.appliedIds()).toEqual([]);
  });
});

describe('pendingMigrations', () => {
  it('lists migrations not yet applied', async () => {
    const client = new FakeClient(['0001_a']);
    expect(await pendingMigrations(client, twoMigrations)).toEqual(['0002_b']);
  });

  it('defaults to the shipped migration set', async () => {
    const client = new FakeClient();
    expect(await pendingMigrations(client)).toEqual(migrations.map((m) => m.id));
  });
});
