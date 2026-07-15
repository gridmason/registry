import { hashWireVectors } from '@gridmason/protocol/vectors';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import type { AuditEvent } from '../../src/audit/index.js';
import { noopAuditSink, setAuditSink } from '../../src/audit/index.js';
import { createOidcVerifier } from '../../src/auth/oidc.js';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import { composeOidcIdentity } from '../../src/publisher/types.js';
import { buildServer } from '../../src/server.js';
import { InMemoryObjectStore } from '../../src/storage/object-store.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';

const REGISTRY_ID = 'registry.test';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

const config = loadConfig({ LOG_LEVEL: 'silent', REGISTRY_ID });
const logger = createLogger(config);

// The `reason: 'ok'` vector whose input is the canonical bytes of a document:
// its `expected` is the SHA-256 of those bytes, so a part uploaded with exactly
// those bytes must be content-hashed to exactly `expected` (protocol §4.1 vector).
const hashVector = hashWireVectors.find(
  (v) => v.reason === 'ok' && v.name.includes('canonical'),
)!;
const vectorBase64 = Buffer.from(hashVector.inputHex, 'hex').toString('base64');
const b64 = (s: string): string => Buffer.from(s).toString('base64');

const validEnvelope = {
  formatVersion: '1.0',
  subject: { artifact: 'acme-clock@1.2.0', releaseHash: `sha2-256:${'ab'.repeat(32)}` },
  publisherSig: {
    alg: 'ES256',
    cert: 'MIIBQ2R1bW15Y2VydA==',
    issuer: 'https://issuer.example',
    subjectClaims: { email: 'dev@acme.example' },
    sig: 'ZHVtbXktc2ln',
  },
};

function uploadBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag: 'acme-clock',
    version: '1.2.0',
    files: [
      // The manifest carries the protocol vector's canonical bytes so its content
      // hash is pinned to the vector's expected digest.
      { path: 'manifest.json', role: 'manifest', bytes: vectorBase64 },
      { path: 'entry.js', role: 'entry', bytes: b64('export default 1') },
      { path: 'chunks/a.js', role: 'chunk', bytes: b64('chunk-a') },
    ],
    sourceArchive: b64('source-tarball'),
    envelope: validEnvelope,
    ...overrides,
  };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('publish API', () => {
  let issuer: FakeIssuer;
  let validToken: string;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let publisherStore: InMemoryPublisherStore;
  let artifactStore: InMemoryArtifactStore;
  let objectStore: InMemoryObjectStore;
  let audit: AuditEvent[];

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    validToken = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
  });

  afterAll(async () => {
    await issuer.close();
  });

  beforeEach(async () => {
    publisherStore = new InMemoryPublisherStore();
    // The publishing identity owns the `acme` prefix.
    await publisherStore.register({
      issuer: issuer.issuer,
      subject: 'user-1',
      prefix: 'acme',
      tier: 'verified',
    });
    artifactStore = new InMemoryArtifactStore();
    objectStore = new InMemoryObjectStore();
    const verifier = createOidcVerifier({ issuerAllowlist: [issuer.issuer] });
    app = await buildServer({
      config,
      logger,
      publisherStore,
      artifactStore,
      objectStore,
      oidcVerifier: verifier,
    });
    audit = [];
    setAuditSink({ emit: (event) => audit.push(event) });
  });

  afterEach(async () => {
    setAuditSink(noopAuditSink);
    await app.close();
  });

  async function publish(body: Record<string, unknown>, token = validToken) {
    return app.inject({
      method: 'POST',
      url: '/v1/artifacts',
      headers: auth(token),
      payload: body,
    });
  }

  it('accepts a valid upload: persists a submitted artifact, content-hashes matching the protocol vector, and stores blobs by hash', async () => {
    const res = await publish(uploadBody());

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      registryId: REGISTRY_ID,
      tag: 'acme-clock',
      version: '1.2.0',
      state: 'submitted',
    });
    // The manifest bytes are the vector's canonical bytes -> its expected digest.
    expect(body.contentHashes['manifest.json']).toBe(hashVector.expected);
    expect(typeof body.sourceArchiveRef).toBe('string');

    // The artifact row is persisted in `submitted`.
    const stored = await artifactStore.findByVersion(body.publisherId, 'acme-clock', '1.2.0');
    expect(stored?.state).toBe('submitted');
    expect(stored?.envelope).toEqual(validEnvelope);

    // Every content hash addresses a stored blob; the manifest blob is the exact
    // uploaded bytes.
    for (const hash of Object.values(body.contentHashes) as string[]) {
      expect(await objectStore.headObject(hash)).not.toBeNull();
    }
    const manifestBlob = await objectStore.getObject(hashVector.expected);
    expect(Buffer.from(manifestBlob!).toString('hex')).toBe(hashVector.inputHex);
    // The source archive is stored by its hash.
    expect(await objectStore.headObject(body.sourceArchiveRef)).not.toBeNull();

    expect(audit).toEqual([
      expect.objectContaining({
        actor: composeOidcIdentity(issuer.issuer, 'user-1'),
        action: 'publish.submitted',
        subject: body.id,
      }),
    ]);
  });

  it('refuses a re-upload of the same (publisher, tag, version) with 409 and audits the denial', async () => {
    expect((await publish(uploadBody())).statusCode).toBe(201);

    const res = await publish(uploadBody({ envelope: validEnvelope }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('version_exists');
    expect(audit.map((e) => e.action)).toContain('publish.denied');
    expect(audit.at(-1)).toMatchObject({ subject: 'publish:duplicate-version' });
  });

  it('accepts a new version of an already-published tag', async () => {
    expect((await publish(uploadBody())).statusCode).toBe(201);
    const res = await publish(uploadBody({ version: '1.2.1' }));
    expect(res.statusCode).toBe(201);
  });

  it('rejects a tag outside the publisher prefix with 403 and audits the denial', async () => {
    const res = await publish(uploadBody({ tag: 'other-widget' }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('tag_not_in_prefix');
    expect(audit).toEqual([
      expect.objectContaining({ action: 'publish.denied', subject: 'publish:tag-not-in-prefix' }),
    ]);
  });

  it('rejects a structurally invalid tag with 400', async () => {
    const res = await publish(uploadBody({ tag: 'AcmeClock' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_tag');
  });

  it('rejects a missing or malformed envelope with 400', async () => {
    expect((await publish(uploadBody({ envelope: undefined }))).statusCode).toBe(400);
    const res = await publish(uploadBody({ envelope: { payloadType: 'x' } }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_envelope');
  });

  it('rejects a missing bearer token with 401 without auditing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/artifacts',
      payload: uploadBody(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('missing_token');
    expect(audit).toHaveLength(0);
  });

  it('rejects a token from a non-allowlisted issuer with 403 and audits the denial', async () => {
    const token = await issuer.sign({ iss: 'https://evil.example', sub: 'user-1', exp: FUTURE });
    const res = await publish(uploadBody(), token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('issuer_not_allowed');
    expect(audit).toEqual([
      expect.objectContaining({
        actor: 'anonymous',
        action: 'publish.denied',
        subject: 'publish:issuer-not-allowed',
      }),
    ]);
  });

  it('rejects a verified identity with no publisher record with 403', async () => {
    const token = await issuer.sign({ iss: issuer.issuer, sub: 'stranger', exp: FUTURE });
    const res = await publish(uploadBody(), token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_registered');
    expect(audit).toEqual([
      expect.objectContaining({ action: 'publish.denied', subject: 'publish:not-registered' }),
    ]);
  });
});
