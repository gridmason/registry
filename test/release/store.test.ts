/**
 * Release-doc store (#10): the in-memory store persists a release document and
 * enforces one per artifact (mirroring the Postgres unique index), and read
 * reconstructs the signed {@link ReleaseDoc} from the stored file map + envelope.
 */
import { describe, expect, it } from 'vitest';

import type { ReleaseDoc, SignatureEnvelope, TransparencyLogEntry } from '@gridmason/protocol';

import { InMemoryReleaseDocStore } from '../../src/release/store.js';
import { RELEASE_DOC_FORMAT_VERSION } from '../../src/release/release-doc.js';

const releaseDoc: ReleaseDoc = {
  formatVersion: RELEASE_DOC_FORMAT_VERSION,
  artifact: 'acme-clock@1.2.0',
  files: { 'entry.js': `sha2-256:${'ab'.repeat(32)}` },
};

const envelope = {
  formatVersion: '1.0',
  subject: { artifact: 'acme-clock@1.2.0', releaseHash: `sha2-256:${'cd'.repeat(32)}` },
  publisherSig: { alg: 'ES256', cert: 'x', issuer: 'https://i', subjectClaims: {}, sig: 's' },
  registrySig: { alg: 'ES256', cert: 'y', sig: 'r' },
  logInclusion: { logId: 'log', index: 0, proof: [] },
} as unknown as SignatureEnvelope;

const logEntry = {
  logId: 'log',
  index: 0,
  integratedTime: 1,
  canonicalBody: 'e30=',
  inclusionProof: { treeSize: 1, rootHash: 'ab'.repeat(32), hashes: [] },
  checkpoint: 'registry.test\n1\ncm9vdA==\n\n— registry.test AAAA\n',
} as TransparencyLogEntry;

function input(artifactId: string, waiverFlagged = false) {
  return { artifactId, releaseDoc, envelope, logRef: 'log:0', logEntry, waiverFlagged };
}

describe('InMemoryReleaseDocStore', () => {
  it('persists and reads back a release document', async () => {
    const store = new InMemoryReleaseDocStore();
    const created = await store.create(input('artifact-1', true));
    expect(created.waiverFlagged).toBe(true);
    expect(created.logEntry).toEqual(logEntry);

    const found = await store.findByArtifact('artifact-1');
    expect(found?.releaseDoc).toEqual(releaseDoc);
    expect(found?.envelope.registrySig).toBeDefined();
  });

  it('returns null for an artifact with no release document', async () => {
    const store = new InMemoryReleaseDocStore();
    expect(await store.findByArtifact('missing')).toBeNull();
  });

  it('refuses a second release document for the same artifact', async () => {
    const store = new InMemoryReleaseDocStore();
    await store.create(input('artifact-1'));
    await expect(store.create(input('artifact-1'))).rejects.toThrow(/already exists/);
  });
});
