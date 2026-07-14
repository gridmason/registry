/**
 * ACCEPTANCE (#13, FR-7/FR-10): the anonymous Resolution API turns a gate snapshot
 * into an import-map fragment whose every URL a host can **verify with
 * `@gridmason/protocol`**. A realistic release is produced the way the pipeline
 * produces one — the publisher-signed content hashes are the real `hashBytes` of
 * the served bytes, the blobs sit in the object store as intake left them, and an
 * HTTP review approval drives countersign (#10) to emit the signed release
 * document. Over that:
 *
 *  - `POST /v1/resolve` works with **no auth** and no deployment registration;
 *  - the fragment carries the registry id (source-qualified identity, SPEC §9);
 *  - each module's hash-pinned URL fetches from the serving surface (#12) and its
 *    signature bundle passes the full `verifyRelease` chain — trust root →
 *    signatures → transparency log — exactly as a host checks it before loading;
 *  - a `sharedScope` widget that needs a non-default major gets a `scopes` entry.
 *
 * As `serving.test.ts` does, the pipeline is exercised from the review-approval
 * step onward: intake's placeholder envelope is not yet the countersign-verifiable
 * shape (P-E3), so the artifact is seeded and approved from the countersign fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashBytes, verifyRelease, type MultihashString, type TrustRootPin } from '@gridmason/protocol';

import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import { noopAuditSink, setAuditSink } from '../../src/audit/index.js';
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

// The exact served bytes of each artifact file. The manifest names its `entry`
// path and a `sharedScope` the shell must satisfy (GW-D22) — both are covered by
// the manifest hash the publisher signs, so resolution reads them from real bytes.
const FILES: Readonly<Record<string, Uint8Array>> = {
  'manifest.json': new TextEncoder().encode(
    JSON.stringify({
      formatVersion: '1.0',
      tag: 'acme-clock',
      entry: 'entry.js',
      sharedScope: { react: '^17.0.0' },
    }),
  ),
  'entry.js': new TextEncoder().encode('export default class extends HTMLElement {}'),
};

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  contentHashes: Record<string, MultihashString>;
  publisher: Awaited<ReturnType<typeof makePublisherFixture>>;
  countersign: ReturnType<typeof makeCountersignFixture>;
  log: InMemoryTransparencyLog;
}

async function harness(reviewerToken: string, issuer: FakeIssuer): Promise<Harness> {
  const contentHashes: Record<string, MultihashString> = {};
  for (const [path, bytes] of Object.entries(FILES)) {
    contentHashes[path] = await hashBytes(bytes);
  }
  const publisher = await makePublisherFixture({
    artifactId: ARTIFACT_ID,
    files: contentHashes,
    issuer: issuer.issuer,
  });
  const countersign = makeCountersignFixture();

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

  const artifactStore = new InMemoryArtifactStore();
  const created = await artifactStore.create({
    publisherId: author!.id,
    tag: 'acme-clock',
    version: '1.2.0',
    contentHashes,
    sourceArchiveRef: null,
    envelope: publisher.publisherEnvelope,
  });
  if (!created.ok) throw new Error('seed failed');
  await artifactStore.transition(created.record.id, 'submitted', 'reviewing');

  const reviewCaseStore = new InMemoryReviewCaseStore();
  const reviewCase = await reviewCaseStore.create({
    artifactId: created.record.id,
    checksReport: report,
  });

  const log = new InMemoryTransparencyLog(REGISTRY_ID);
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
    countersignIdentity: loadCountersignIdentity(countersign)!,
    transparencyLog: log,
    oidcVerifier: createOidcVerifier({ issuerAllowlist: [issuer.issuer] }),
  });

  const verdict = await app.inject({
    method: 'POST',
    url: `/v1/review/cases/${reviewCase.id}/verdict`,
    headers: { authorization: `Bearer ${reviewerToken}` },
    payload: { decision: 'approve' },
  });
  if (verdict.statusCode !== 201) {
    throw new Error(`approval did not publish a release: ${verdict.statusCode} ${verdict.payload}`);
  }

  return { app, contentHashes, publisher, countersign, log };
}

/** The gate snapshot a host with react 18 + 17 available would send for this widget. */
function gateSnapshot() {
  return {
    registry: REGISTRY_ID,
    modules: [{ publisher: 'acme', tag: 'acme-clock', version: '1.2.0' }],
    shared: {
      react: [
        { major: 18, url: '/vendor/react@18.js' },
        { major: 17, url: '/vendor/react@17.js' },
      ],
    },
  };
}

describe('Resolution API — anonymous fragment, verifiable via @gridmason/protocol', () => {
  let issuer: FakeIssuer;
  let reviewerToken: string;
  let h: Harness;

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    reviewerToken = await issuer.sign({ iss: issuer.issuer, sub: REVIEWER_SUB, exp: FUTURE });
  });
  afterAll(async () => {
    await issuer.close();
  });

  beforeEach(async () => {
    setAuditSink({ emit: () => {} });
    h = await harness(reviewerToken, issuer);
  });
  afterEach(async () => {
    setAuditSink(noopAuditSink);
    await h.app.close();
  });

  it('resolves a gate snapshot anonymously into a fragment carrying the registry id', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/v1/resolve', payload: gateSnapshot() });

    // No Authorization header was sent — resolution works anonymously (SPEC §8).
    expect(res.statusCode).toBe(200);
    const fragment = res.json();
    expect(fragment.registry).toBe(REGISTRY_ID);
    expect(fragment.excluded).toEqual([]);
    expect(fragment.modules).toHaveLength(1);

    const entryHash = h.contentHashes['entry.js']!;
    expect(fragment.imports[`${REGISTRY_ID}/acme-clock`]).toBe(`/v1/artifacts/${entryHash}`);
    // The widget needs react ^17 while the shell default is 18 → a scoped override.
    expect(fragment.scopes[`/v1/artifacts/${entryHash}`]).toEqual({ react: '/vendor/react@17.js' });
  });

  it('every fragment URL fetches from serving and verifies via verifyRelease', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/v1/resolve', payload: gateSnapshot() });
    const fragment = res.json();

    // The pinned material a host holds out of band (built from the fixtures, as in
    // the countersign acceptance test): trust root + CA/countersign roots + log key.
    const pins: TrustRootPin[] = [
      { registryId: REGISTRY_ID, root: 'cs-root', channel: 'build-time' },
    ];
    const trustRoot = {
      formatVersion: '1.0',
      registryId: REGISTRY_ID,
      countersignRoots: ['cs-root'],
      issuerAllowlist: [h.publisher.issuer],
      logPublicKeys: ['log-key'],
      notBefore: 0,
      notAfter: Date.now() + 3_600_000,
    };

    for (const module of fragment.modules) {
      // 1. The URL fetches the exact immutable bytes from the serving surface (#12).
      const served = await h.app.inject({ method: 'GET', url: module.url });
      expect(served.statusCode).toBe(200);
      const bytes = new Uint8Array(served.rawPayload);

      // 2. The full release chain verifies from the fragment's own signature bundle.
      const verdict = await verifyRelease({
        release: module.bundle.release,
        envelope: module.bundle.envelope,
        trustRoot,
        pins,
        publisherCARoots: [h.publisher.publisherCASpki],
        countersignRoots: [h.countersign.countersignRootSpki],
        logEntry: module.bundle.logEntry,
        logPublicKey: h.log.publicKey(),
        now: Date.now(),
      });
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;

      // 3. The bytes the URL served hash to the hash the verified release pins for
      //    the entry — so the URL is verified end to end (the acceptance).
      const servedHash = await hashBytes(bytes);
      const pinned = [...verdict.urlHashes.values()];
      expect(pinned).toContain(servedHash);
      expect(module.url).toBe(`/v1/artifacts/${servedHash}`);
    }
  });

  it('refuses a snapshot targeting a different registry with a typed error', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/resolve',
      payload: { ...gateSnapshot(), registry: 'someone.else' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('wrong_registry');
  });

  it('refuses a malformed gate snapshot with a typed 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/resolve',
      payload: { registry: REGISTRY_ID, modules: 'not-an-array' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('excludes an unknown module without failing the request', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/resolve',
      payload: {
        registry: REGISTRY_ID,
        modules: [{ publisher: 'acme', tag: 'acme-clock', version: '9.9.9' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const fragment = res.json();
    expect(fragment.modules).toEqual([]);
    expect(fragment.excluded[0].reason).toBe('unknown_module');
  });
});
