/**
 * Hash-addressed serving (#12, FR-6) end to end. A realistic release is produced
 * the way the pipeline produces one — the publisher-signed content hashes are the
 * real `hashBytes` of the served bytes, the blobs sit in the object store as
 * intake left them, and an HTTP review approval drives countersign (#10) to emit
 * the signed release document. Over that, the serving surface is asserted:
 *
 *  - every served path's bytes hash-match its signed release entry (the acceptance);
 *  - responses are immutably cacheable, hash-addressed (ETag = hash), typed;
 *  - a hash no signed release lists — an unknown hash, or the review-only source
 *    archive, which is *present in the store* — refuses with 404;
 *  - the surface is read-only: no mutating method is routed on a served object;
 *  - the countersigned release document is fetchable by its release hash.
 *
 * The artifact is seeded and approved from the countersign fixtures rather than
 * posted through DSSE publish intake: intake's placeholder envelope shape is not
 * yet the countersign-verifiable shape (P-E3), so — as `lane-integration.test.ts`
 * does — the pipeline is exercised from the review-approval step onward.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canonicalize, hashBytes } from '@gridmason/protocol';
import type { MultihashString, ReleaseHashMap } from '@gridmason/protocol';

import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import { noopAuditSink, setAuditSink, type AuditEvent } from '../../src/audit/index.js';
import { createOidcVerifier } from '../../src/auth/oidc.js';
import { loadConfig } from '../../src/config/index.js';
import { loadCountersignIdentity } from '../../src/countersign/identity.js';
import { createLogger } from '../../src/logging/index.js';
import { composeOidcIdentity } from '../../src/publisher/types.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import { InMemoryReleaseDocStore } from '../../src/release/store.js';
import type { AutomatedReviewReport } from '../../src/review/report.js';
import { InMemoryReviewCaseStore } from '../../src/review/store.js';
import { buildServer } from '../../src/server.js';
import { InMemoryTransparencyLog } from '../../src/sigstore/log.js';
import { InMemoryObjectStore } from '../../src/storage/object-store.js';
import {
  makeCountersignFixture,
  makePublisherFixture,
} from '../countersign/fixtures/envelope.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';

const REGISTRY_ID = 'registry.test';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const AUTHOR_SUB = 'author-1';
const REVIEWER_SUB = 'reviewer-1';
const ARTIFACT_ID = 'acme-clock@1.2.0';

const report: AutomatedReviewReport = {
  checksModule: '@gridmason/cli/checks',
  checksVersion: '0.0.3',
  status: 'pass',
  results: [{ id: 'manifest.schema', status: 'pass', message: 'ok' }],
};

// The exact served bytes of each artifact file — what the CDN serves verbatim.
const FILES: Readonly<Record<string, Uint8Array>> = {
  'manifest.json': new TextEncoder().encode(
    JSON.stringify({ formatVersion: '1.0', tag: 'acme-clock', entry: 'entry.js' }),
  ),
  'entry.js': new TextEncoder().encode('export default class extends HTMLElement {}'),
};
const SOURCE_ARCHIVE = new TextEncoder().encode('a signed source tarball; review input only');

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  caseId: string;
  contentHashes: ReleaseHashMap;
  releaseHash: MultihashString;
  sourceHash: MultihashString;
}

async function harness(reviewerToken: string, issuer: FakeIssuer): Promise<Harness> {
  // Content-address the served files exactly as intake does, then sign a release
  // over that map so the countersign stage's rebuilt hash matches the subject.
  const contentHashes: Record<string, MultihashString> = {};
  for (const [path, bytes] of Object.entries(FILES)) {
    contentHashes[path] = await hashBytes(bytes);
  }
  const sourceHash = await hashBytes(SOURCE_ARCHIVE);
  const fixture = await makePublisherFixture({
    artifactId: ARTIFACT_ID,
    files: contentHashes,
    issuer: issuer.issuer,
  });
  const releaseHash = await hashBytes(fixture.releaseBytes);

  const publisherStore = new InMemoryPublisherStore();
  await publisherStore.register({
    issuer: issuer.issuer,
    subject: AUTHOR_SUB,
    prefix: 'acme',
    tier: 'operator',
  });
  const author = await publisherStore.findByIdentity(issuer.issuer, AUTHOR_SUB);

  const objectStore = new InMemoryObjectStore();
  for (const [path, bytes] of Object.entries(FILES)) {
    await objectStore.putObject(contentHashes[path]!, bytes);
  }
  // The source archive is stored by hash at intake but listed by no release doc.
  await objectStore.putObject(sourceHash, SOURCE_ARCHIVE);

  const artifactStore = new InMemoryArtifactStore();
  const created = await artifactStore.create({
    publisherId: author!.id,
    tag: 'acme-clock',
    version: '1.2.0',
    contentHashes,
    sourceArchiveRef: sourceHash,
    envelope: fixture.publisherEnvelope,
  });
  if (!created.ok) throw new Error('seed failed');
  await artifactStore.transition(created.record.id, 'submitted', 'reviewing');

  const reviewCaseStore = new InMemoryReviewCaseStore();
  const reviewCase = await reviewCaseStore.create({
    artifactId: created.record.id,
    checksReport: report,
  });

  const config = loadConfig({
    LOG_LEVEL: 'silent',
    REGISTRY_ID,
    REVIEW_REVIEWER_IDENTITIES: composeOidcIdentity(issuer.issuer, REVIEWER_SUB),
  });
  const app = await buildServer({
    config,
    logger: createLogger(config),
    publisherStore,
    artifactStore,
    objectStore,
    reviewCaseStore,
    releaseDocStore: new InMemoryReleaseDocStore(),
    countersignIdentity: loadCountersignIdentity(makeCountersignFixture())!,
    transparencyLog: new InMemoryTransparencyLog(REGISTRY_ID),
    oidcVerifier: createOidcVerifier({ issuerAllowlist: [issuer.issuer] }),
  });

  // Drive the approval that runs countersign and emits the signed release doc.
  const verdict = await app.inject({
    method: 'POST',
    url: `/v1/review/cases/${reviewCase.id}/verdict`,
    headers: { authorization: `Bearer ${reviewerToken}` },
    payload: { decision: 'approve' },
  });
  if (verdict.statusCode !== 201) {
    throw new Error(`approval did not publish a release: ${verdict.statusCode} ${verdict.payload}`);
  }

  return { app, caseId: reviewCase.id, contentHashes, releaseHash, sourceHash };
}

describe('hash-addressed serving', () => {
  let issuer: FakeIssuer;
  let reviewerToken: string;
  let h: Harness;
  let audit: AuditEvent[];

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    reviewerToken = await issuer.sign({ iss: issuer.issuer, sub: REVIEWER_SUB, exp: FUTURE });
  });

  afterAll(async () => {
    await issuer.close();
  });

  beforeEach(async () => {
    audit = [];
    setAuditSink({ emit: (event) => audit.push(event) });
    h = await harness(reviewerToken, issuer);
  });

  afterEach(async () => {
    setAuditSink(noopAuditSink);
    await h.app.close();
  });

  it('serves each path with bytes that hash-match its signed release entry', async () => {
    for (const [path, bytes] of Object.entries(FILES)) {
      const hash = h.contentHashes[path]!;
      const res = await h.app.inject({ method: 'GET', url: `/v1/artifacts/${hash}` });

      expect(res.statusCode).toBe(200);
      // Served bytes hash-match the release doc entry (the acceptance).
      expect(await hashBytes(new Uint8Array(res.rawPayload))).toBe(hash);
      expect(new Uint8Array(res.rawPayload)).toEqual(bytes);
    }
  });

  it('marks served objects immutable, hash-addressed, and typed', async () => {
    const manifestHash = h.contentHashes['manifest.json']!;
    const res = await h.app.inject({ method: 'GET', url: `/v1/artifacts/${manifestHash}` });

    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['etag']).toBe(`"${manifestHash}"`);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');

    const entryHash = h.contentHashes['entry.js']!;
    const entry = await h.app.inject({ method: 'GET', url: `/v1/artifacts/${entryHash}` });
    expect(entry.headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  it('answers 304 when the caller already holds the hash (If-None-Match)', async () => {
    const hash = h.contentHashes['entry.js']!;
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/artifacts/${hash}`,
      headers: { 'if-none-match': `"${hash}"` },
    });
    expect(res.statusCode).toBe(304);
    expect(res.rawPayload.length).toBe(0);
  });

  it('refuses a hash no signed release lists (unknown hash)', async () => {
    const unknown = `sha2-256:${'00'.repeat(32)}` as const;
    const res = await h.app.inject({ method: 'GET', url: `/v1/artifacts/${unknown}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('unknown_hash');
  });

  it('refuses the source archive even though its blob is present in the store', async () => {
    // The source archive is content-addressed in the object store at intake, but
    // no release document lists it — so it is not servable (review input, not a
    // served remote). This is the membership gate, not a missing-blob 404.
    const res = await h.app.inject({ method: 'GET', url: `/v1/artifacts/${h.sourceHash}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('unknown_hash');
  });

  it('routes no mutating method on a served object (immutability, SPEC §3)', async () => {
    const hash = h.contentHashes['entry.js']!;
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      const artifact = await h.app.inject({ method, url: `/v1/artifacts/${hash}` });
      expect(artifact.statusCode).toBe(404);
      const release = await h.app.inject({ method, url: `/v1/releases/${h.releaseHash}` });
      expect(release.statusCode).toBe(404);
    }
    expect(audit.map((e) => e.action)).not.toContain('serving.mutation');
  });

  it('fetches the countersigned release document by its release hash', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/v1/releases/${h.releaseHash}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['etag']).toBe(`"${h.releaseHash}"`);

    const body = res.json();
    // The signed release document canonicalizes to the release hash it is served at.
    expect(await hashBytes(canonicalize(body.releaseDoc))).toBe(h.releaseHash);
    // It carries the completed dual signature and the log inclusion a host verifies.
    expect(body.envelope.registrySig).toBeDefined();
    expect(body.envelope.logInclusion).toBeDefined();
    expect(body.logEntry).toBeDefined();
  });

  it('refuses a release-doc fetch for an unknown release hash', async () => {
    const unknown = `sha2-256:${'11'.repeat(32)}` as const;
    const res = await h.app.inject({ method: 'GET', url: `/v1/releases/${unknown}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('unknown_release');
  });

  it('does not emit a per-request audit event on the serving hot path', async () => {
    audit.length = 0;
    await h.app.inject({ method: 'GET', url: `/v1/artifacts/${h.contentHashes['entry.js']!}` });
    await h.app.inject({ method: 'GET', url: `/v1/releases/${h.releaseHash}` });
    expect(audit).toHaveLength(0);
  });
});
