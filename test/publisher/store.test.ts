import { describe, expect, it } from 'vitest';

import type { Postgres } from '../../src/db/postgres.js';
import {
  createPostgresPublisherStore,
  InMemoryPublisherStore,
} from '../../src/publisher/store.js';

const input = {
  issuer: 'https://accounts.example.com',
  subject: 'user-1',
  prefix: 'acme',
  tier: 'community',
} as const;

describe('InMemoryPublisherStore', () => {
  it('registers a publisher and reads it back by id, prefix, and identity', async () => {
    const store = new InMemoryPublisherStore();
    const result = await store.register(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { record } = result;
    expect(record).toMatchObject({ issuer: input.issuer, prefix: 'acme', tier: 'community' });
    expect(await store.findById(record.id)).toEqual(record);
    expect(await store.findByPrefix('acme')).toEqual(record);
    expect(await store.findByIdentity(input.issuer, input.subject)).toEqual(record);
  });

  it('rejects a prefix already claimed on this registry', async () => {
    const store = new InMemoryPublisherStore();
    await store.register(input);
    const clash = await store.register({ ...input, subject: 'user-2' });
    expect(clash).toEqual({ ok: false, conflict: 'prefix' });
  });

  it('allows the same prefix once the identity differs only across stores (registries)', async () => {
    // One store == one registry (one database). A second registry is a second
    // store; the same prefix is free there — uniqueness is per registry (SPEC §9).
    const flagship = new InMemoryPublisherStore();
    const priv = new InMemoryPublisherStore();
    expect((await flagship.register(input)).ok).toBe(true);
    expect((await priv.register(input)).ok).toBe(true);
  });

  it('rejects a second registration for the same identity', async () => {
    const store = new InMemoryPublisherStore();
    await store.register(input);
    const clash = await store.register({ ...input, prefix: 'other' });
    expect(clash).toEqual({ ok: false, conflict: 'identity' });
  });

  it('returns null for unknown lookups', async () => {
    const store = new InMemoryPublisherStore();
    expect(await store.findById('nope')).toBeNull();
    expect(await store.findByPrefix('nope')).toBeNull();
    expect(await store.findByIdentity('nope', 'nope')).toBeNull();
  });
});

/** A fake Postgres that returns `rows` for a query, or throws `error`. */
function fakePostgres(rows: unknown[], error?: unknown): Postgres {
  return {
    query: () => (error ? Promise.reject(error) : Promise.resolve({ rows } as never)),
    withClient: (fn) => fn({ query: () => Promise.resolve({ rows: [] }) }),
    ping: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

const row = {
  id: 'pub-1',
  oidc_issuer: input.issuer,
  oidc_subject: input.subject,
  prefix: 'acme',
  tier: 'community',
  created_at: new Date('2026-07-14T00:00:00.000Z'),
};

describe('createPostgresPublisherStore', () => {
  it('maps an inserted row to a publisher record', async () => {
    const store = createPostgresPublisherStore(fakePostgres([row]));
    const result = await store.register(input);
    expect(result).toEqual({
      ok: true,
      record: {
        id: 'pub-1',
        issuer: input.issuer,
        subject: input.subject,
        prefix: 'acme',
        tier: 'community',
        createdAt: row.created_at,
      },
    });
  });

  it('maps a prefix unique-violation (23505) to a prefix conflict', async () => {
    const err = { code: '23505', constraint: 'publisher_prefix_key' };
    const store = createPostgresPublisherStore(fakePostgres([], err));
    expect(await store.register(input)).toEqual({ ok: false, conflict: 'prefix' });
  });

  it('maps an identity unique-violation (23505) to an identity conflict', async () => {
    const err = { code: '23505', constraint: 'publisher_oidc_identity_key' };
    const store = createPostgresPublisherStore(fakePostgres([], err));
    expect(await store.register(input)).toEqual({ ok: false, conflict: 'identity' });
  });

  it('rethrows a non-unique-violation error', async () => {
    const err = { code: '08006', message: 'connection failure' };
    const store = createPostgresPublisherStore(fakePostgres([], err));
    await expect(store.register(input)).rejects.toBe(err);
  });
});
