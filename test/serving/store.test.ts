/**
 * Release-doc store serving lookups (#12): `findServedPathForHash` is the serving
 * authority check — it returns a path only for a content hash a signed release
 * lists, and null otherwise — and `findByReleaseHash` resolves a release document
 * by the hash its publisher signed. Asserted on the in-memory store (the Postgres
 * store mirrors it via `jsonb_each_text` / the envelope subject).
 */
import { describe, expect, it } from 'vitest';

import type {
  MultihashString,
  ReleaseDoc,
  SignatureEnvelope,
  TransparencyLogEntry,
} from '@gridmason/protocol';

import { InMemoryReleaseDocStore } from '../../src/release/store.js';
import { RELEASE_DOC_FORMAT_VERSION } from '../../src/release/release-doc.js';

const MANIFEST_HASH: MultihashString = `sha2-256:${'ab'.repeat(32)}`;
const ENTRY_HASH: MultihashString = `sha2-256:${'cd'.repeat(32)}`;
const RELEASE_HASH: MultihashString = `sha2-256:${'ef'.repeat(32)}`;

const releaseDoc: ReleaseDoc = {
  formatVersion: RELEASE_DOC_FORMAT_VERSION,
  artifact: 'acme-clock@1.2.0',
  files: { 'manifest.json': MANIFEST_HASH, 'entry.js': ENTRY_HASH },
};

const envelope = {
  formatVersion: '1.0',
  subject: { artifact: 'acme-clock@1.2.0', releaseHash: RELEASE_HASH },
  publisherSig: { alg: 'ES256', cert: 'x', issuer: 'https://i', subjectClaims: {}, sig: 's' },
  registrySig: { alg: 'ES256', cert: 'y', sig: 'r' },
  logInclusion: { logId: 'log', index: 0, proof: [] },
} as unknown as SignatureEnvelope;

const logEntry = { logId: 'log', index: 0 } as unknown as TransparencyLogEntry;

async function seeded(): Promise<InMemoryReleaseDocStore> {
  const store = new InMemoryReleaseDocStore();
  await store.create({
    artifactId: 'artifact-1',
    releaseDoc,
    envelope,
    logRef: 'log:0',
    logEntry,
    waiverFlagged: false,
  });
  return store;
}

describe('findServedPathForHash', () => {
  it('returns a served path for a hash the release lists', async () => {
    const store = await seeded();
    expect(await store.findServedPathForHash(MANIFEST_HASH)).toBe('manifest.json');
    expect(await store.findServedPathForHash(ENTRY_HASH)).toBe('entry.js');
  });

  it('returns null for a hash no release lists', async () => {
    const store = await seeded();
    expect(await store.findServedPathForHash(`sha2-256:${'00'.repeat(32)}`)).toBeNull();
    // The release hash itself is not a served-file hash.
    expect(await store.findServedPathForHash(RELEASE_HASH)).toBeNull();
  });
});

describe('findByReleaseHash', () => {
  it('resolves the release document by its signed release hash', async () => {
    const store = await seeded();
    const found = await store.findByReleaseHash(RELEASE_HASH);
    expect(found?.artifactId).toBe('artifact-1');
    expect(found?.releaseDoc).toEqual(releaseDoc);
  });

  it('returns null for an unknown release hash', async () => {
    const store = await seeded();
    expect(await store.findByReleaseHash(`sha2-256:${'11'.repeat(32)}`)).toBeNull();
  });
});
