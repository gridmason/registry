import { describe, expect, it } from 'vitest';

import {
  createPostgresArtifactStore,
  InMemoryArtifactStore,
  type CreateArtifactInput,
} from '../../src/artifact/store.js';
import type { Postgres } from '../../src/db/postgres.js';
import type { Logger } from '../../src/logging/index.js';

const input: CreateArtifactInput = {
  publisherId: 'pub-1',
  tag: 'acme-clock',
  version: '1.2.0',
  contentHashes: { 'manifest.json': 'sha2-256:aaaa', 'entry.js': 'sha2-256:bbbb' },
  sourceArchiveRef: 'sha2-256:cccc',
  envelope: { formatVersion: '1.0', subject: { artifact: 'acme-clock@1.2.0', releaseHash: 'sha2-256:aa' }, publisherSig: { alg: 'ES256', cert: 'c', issuer: 'i', subjectClaims: {}, sig: 's' } },
};

describe('InMemoryArtifactStore', () => {
  it('creates a submitted artifact and reads it back by id and version', async () => {
    const store = new InMemoryArtifactStore();
    const result = await store.create(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { record } = result;
    expect(record).toMatchObject({
      publisherId: 'pub-1',
      tag: 'acme-clock',
      version: '1.2.0',
      state: 'submitted',
      sourceArchiveRef: 'sha2-256:cccc',
    });
    expect(record.contentHashes).toEqual(input.contentHashes);
    expect(await store.findById(record.id)).toEqual(record);
    expect(await store.findByVersion('pub-1', 'acme-clock', '1.2.0')).toEqual(record);
  });

  it('refuses a re-upload of the same (publisher, tag, version) as a version conflict', async () => {
    const store = new InMemoryArtifactStore();
    await store.create(input);
    expect(await store.create(input)).toEqual({ ok: false, conflict: 'version' });
  });

  it('allows the same tag+version for a different publisher', async () => {
    const store = new InMemoryArtifactStore();
    await store.create(input);
    const other = await store.create({ ...input, publisherId: 'pub-2' });
    expect(other.ok).toBe(true);
  });

  it('allows a different version under the same tag', async () => {
    const store = new InMemoryArtifactStore();
    await store.create(input);
    const next = await store.create({ ...input, version: '1.2.1' });
    expect(next.ok).toBe(true);
  });

  it('returns null for unknown lookups', async () => {
    const store = new InMemoryArtifactStore();
    expect(await store.findById('nope')).toBeNull();
    expect(await store.findByVersion('nope', 'nope', 'nope')).toBeNull();
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
  id: 'art-1',
  publisher_id: 'pub-1',
  tag: 'acme-clock',
  version: '1.2.0',
  content_hashes: input.contentHashes,
  source_archive_ref: 'sha2-256:cccc',
  envelope: input.envelope,
  state: 'submitted',
  created_at: new Date('2026-07-14T00:00:00.000Z'),
};

describe('createPostgresArtifactStore', () => {
  it('maps an inserted row to an artifact record', async () => {
    const store = createPostgresArtifactStore(fakePostgres([row]));
    const result = await store.create(input);
    expect(result).toEqual({
      ok: true,
      record: {
        id: 'art-1',
        publisherId: 'pub-1',
        tag: 'acme-clock',
        version: '1.2.0',
        contentHashes: input.contentHashes,
        sourceArchiveRef: 'sha2-256:cccc',
        envelope: input.envelope,
        state: 'submitted',
        createdAt: row.created_at,
      },
    });
  });

  it('maps a version unique-violation (23505) to a version conflict', async () => {
    const err = { code: '23505', constraint: 'artifact_version_key' };
    const store = createPostgresArtifactStore(fakePostgres([], err));
    expect(await store.create(input)).toEqual({ ok: false, conflict: 'version' });
  });

  it('rethrows a non-unique-violation error', async () => {
    const err = { code: '08006', message: 'connection failure' };
    const store = createPostgresArtifactStore(fakePostgres([], err));
    await expect(store.create(input)).rejects.toBe(err);
  });

  it('rethrows an unrecognised unique violation and logs its constraint (no false conflict)', async () => {
    const err = { code: '23505', constraint: 'artifact_future_unique_key' };
    const warnings: Array<Record<string, unknown>> = [];
    const logger = { warn: (obj: Record<string, unknown>) => warnings.push(obj) } as unknown as Logger;
    const store = createPostgresArtifactStore(fakePostgres([], err), logger);
    await expect(store.create(input)).rejects.toBe(err);
    expect(warnings).toEqual([
      expect.objectContaining({ code: '23505', constraint: 'artifact_future_unique_key' }),
    ]);
  });
});
