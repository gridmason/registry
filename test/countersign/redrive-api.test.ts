/**
 * Release re-drive ops endpoint (#38): `POST /v1/ops/artifacts/:id/redrive-release`
 * over the HTTP surface. Covers the operator auth boundary (401/403), the rejection
 * contract (404 not-found, 409 not-approved / already-released), and the happy path
 * that completes an approved-unpublished artifact once the log is available.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import { noopAuditSink, setAuditSink, type AuditEvent } from '../../src/audit/index.js';
import { createOidcVerifier } from '../../src/auth/oidc.js';
import { loadConfig } from '../../src/config/index.js';
import { loadCountersignIdentity } from '../../src/countersign/identity.js';
import { createLogger } from '../../src/logging/index.js';
import { composeOidcIdentity } from '../../src/publisher/types.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import { InMemoryReleaseDocStore } from '../../src/release/store.js';
import { InMemoryReviewCaseStore } from '../../src/review/store.js';
import type { AutomatedReviewReport } from '../../src/review/report.js';
import { InMemoryFeedEntryStore } from '../../src/revocation/store.js';
import { buildServer } from '../../src/server.js';
import { InMemoryObjectStore } from '../../src/storage/object-store.js';
import { InMemoryTransparencyLog } from '../../src/sigstore/log.js';
import { makeCountersignFixture, makePublisherFixture } from './fixtures/envelope.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';

const REGISTRY_ID = 'registry.test';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const OPERATOR_SUB = 'operator-1';
const STRANGER_SUB = 'stranger-1';

const PASS_REPORT: AutomatedReviewReport = {
  checksModule: '@gridmason/cli/checks',
  checksVersion: '0.0.3',
  status: 'pass',
  results: [{ id: 'manifest.schema', status: 'pass', message: 'ok' }],
};

describe('release re-drive endpoint (#38)', () => {
  let issuer: FakeIssuer;
  let operatorToken: string;
  let strangerToken: string;
  let operatorId: string;
  let logger: ReturnType<typeof createLogger>;

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    operatorToken = await issuer.sign({ iss: issuer.issuer, sub: OPERATOR_SUB, exp: FUTURE });
    strangerToken = await issuer.sign({ iss: issuer.issuer, sub: STRANGER_SUB, exp: FUTURE });
    operatorId = composeOidcIdentity(issuer.issuer, OPERATOR_SUB);
    logger = createLogger(loadConfig({ LOG_LEVEL: 'silent', REGISTRY_ID }));
  });

  afterAll(async () => {
    await issuer.close();
  });

  beforeEach(() => setAuditSink({ emit: (_e: AuditEvent) => void _e }));
  afterEach(() => setAuditSink(noopAuditSink));

  async function makeApp() {
    const config = loadConfig({
      LOG_LEVEL: 'silent',
      REGISTRY_ID,
      OPS_OPERATOR_IDENTITIES: operatorId,
    });
    const publisherStore = new InMemoryPublisherStore();
    const artifactStore = new InMemoryArtifactStore();
    const reviewCaseStore = new InMemoryReviewCaseStore();
    const releaseDocStore = new InMemoryReleaseDocStore();
    const app = await buildServer({
      config,
      logger,
      publisherStore,
      artifactStore,
      objectStore: new InMemoryObjectStore(),
      reviewCaseStore,
      releaseDocStore,
      feedEntryStore: new InMemoryFeedEntryStore(),
      transparencyLog: new InMemoryTransparencyLog('registry.test'),
      countersignIdentity: loadCountersignIdentity(makeCountersignFixture())!,
      oidcVerifier: createOidcVerifier({ issuerAllowlist: [issuer.issuer] }),
    });
    return { app, artifactStore, reviewCaseStore, releaseDocStore };
  }

  type App = Awaited<ReturnType<typeof buildServer>>;

  const redrive = (app: App, id: string, token = operatorToken) =>
    app.inject({
      method: 'POST',
      url: `/v1/ops/artifacts/${id}/redrive-release`,
      headers: { authorization: `Bearer ${token}` },
    });

  /** Seed an artifact in `approved` state with a valid envelope, no release doc. */
  async function seedApproved(
    stores: Awaited<ReturnType<typeof makeApp>>,
    version = '1.2.0',
  ): Promise<string> {
    const { artifactStore, reviewCaseStore } = stores;
    const fixture = await makePublisherFixture({ artifactId: `acme-clock@${version}` });
    const created = await artifactStore.create({
      publisherId: 'pub-1',
      tag: 'acme-clock',
      version,
      contentHashes: fixture.files,
      sourceArchiveRef: null,
      envelope: fixture.publisherEnvelope,
    });
    if (!created.ok) throw new Error('seed failed');
    await artifactStore.transition(created.record.id, 'submitted', 'approved');
    const reviewCase = await reviewCaseStore.create({
      artifactId: created.record.id,
      checksReport: PASS_REPORT,
    });
    await reviewCaseStore.recordVerdict({
      caseId: reviewCase.id,
      reviewer: 'rev-1',
      verdict: 'approved',
      findings: [],
      waiverUsed: false,
    });
    return created.record.id;
  }

  it('rejects a missing token (401) and a non-operator (403)', async () => {
    const stores = await makeApp();
    const id = await seedApproved(stores);
    const anon = await stores.app.inject({
      method: 'POST',
      url: `/v1/ops/artifacts/${id}/redrive-release`,
    });
    expect(anon.statusCode).toBe(401);
    const stranger = await redrive(stores.app, id, strangerToken);
    expect(stranger.statusCode).toBe(403);
    await stores.app.close();
  });

  it('completes an approved-unpublished artifact (201) and publishes its release', async () => {
    const stores = await makeApp();
    const id = await seedApproved(stores);
    expect(await stores.releaseDocStore.findByArtifact(id)).toBeNull();

    const res = await redrive(stores.app, id);
    expect(res.statusCode).toBe(201);
    expect(res.json().artifactId).toBe(id);
    expect(await stores.releaseDocStore.findByArtifact(id)).not.toBeNull();
    await stores.app.close();
  });

  it('is idempotent: a second re-drive returns 409 already_released', async () => {
    const stores = await makeApp();
    const id = await seedApproved(stores);
    expect((await redrive(stores.app, id)).statusCode).toBe(201);
    const again = await redrive(stores.app, id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_released');
    await stores.app.close();
  });

  it('404s an unknown artifact and 409s one that is not approved', async () => {
    const stores = await makeApp();
    const notFound = await redrive(stores.app, 'no-such-artifact');
    expect(notFound.statusCode).toBe(404);

    // A `submitted` artifact is not approved → 409 not_approved.
    const created = await stores.artifactStore.create({
      publisherId: 'pub-1',
      tag: 'acme-clock',
      version: '9.9.9',
      contentHashes: { 'entry.js': `sha2-256:${'ab'.repeat(32)}` as const },
      sourceArchiveRef: null,
      envelope: {},
    });
    if (!created.ok) throw new Error('seed failed');
    const res = await redrive(stores.app, created.record.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_approved');
    await stores.app.close();
  });
});
