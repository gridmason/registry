/**
 * Audit-event completeness matrix (FR-12; SPEC §10) — the cross-cutting guarantee
 * that every FR-1..8 state transition emits an `AuditEvent`.
 *
 * This walks the whole pipeline over the real HTTP surface with `inject()` and
 * in-memory stores — publisher/prefix registration → publish intake → automated
 * review → human verdict (approve *and* reject) → countersign + transparency log →
 * revoke → kill — and asserts the audit trail contains the event each transition
 * must write. The matrix is data (`TRANSITIONS`), so a future change that adds a
 * transition without an audit event fails here.
 *
 * It also pins the SPEC §10 read-surface decision: serving and resolution are
 * hot-path reads, not state transitions, so they emit **no** per-request audit
 * event (the trail records state changes, not reads).
 */
import { sign } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AuditEvent } from '../../src/audit/index.js';
import { noopAuditSink, setAuditSink } from '../../src/audit/index.js';
import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import { createOidcVerifier } from '../../src/auth/oidc.js';
import { loadConfig } from '../../src/config/index.js';
import type { CountersignIdentity } from '../../src/countersign/identity.js';
import { createLogger } from '../../src/logging/index.js';
import { composeOidcIdentity } from '../../src/publisher/types.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import { InMemoryReleaseDocStore } from '../../src/release/store.js';
import { InMemoryReviewCaseStore } from '../../src/review/store.js';
import { InMemoryFeedEntryStore } from '../../src/revocation/store.js';
import { buildServer } from '../../src/server.js';
import { InMemoryObjectStore } from '../../src/storage/object-store.js';
import { buildLeafCertificate, generateP256, spkiDer } from '../countersign/fixtures/certs.js';
import { makePublisherFixture } from '../countersign/fixtures/envelope.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';
import type { AutomatedReviewReport } from '../../src/review/report.js';

const REGISTRY_ID = 'registry.test';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const AUTHOR_SUB = 'author-1';
const REVIEWER_SUB = 'reviewer-1';
const OPERATOR_SUB = 'operator-1';

const b64 = (value: string): string => Buffer.from(value).toString('base64');
const b64json = (value: unknown): string => b64(JSON.stringify(value));

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

function uploadBody(version: string): Record<string, unknown> {
  const manifest = {
    formatVersion: '1.0',
    tag: 'acme-clock',
    kind: 'widget',
    name: 'Acme Clock',
    publisher: 'acme',
    version,
    entry: 'entry.js',
  };
  return {
    tag: 'acme-clock',
    version,
    files: [
      { path: 'manifest.json', role: 'manifest', bytes: b64json(manifest) },
      { path: 'entry.js', role: 'entry', bytes: b64('export default class extends HTMLElement {}') },
    ],
    sourceArchive: b64('source-tarball'),
    envelope: validEnvelope,
  };
}

const PASS_REPORT: AutomatedReviewReport = {
  checksModule: '@gridmason/cli/checks',
  checksVersion: '0.6.0',
  status: 'pass',
  results: [{ id: 'manifest.schema', status: 'pass', message: 'ok' }],
};

function makeCountersignIdentity(): CountersignIdentity {
  const { publicKey, privateKey } = generateP256();
  return {
    sign: (message) =>
      new Uint8Array(sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' })),
    certificateDer: buildLeafCertificate({ subjectPublicKey: publicKey, issuerPrivateKey: privateKey }),
    publicKeySpkiDer: spkiDer(publicKey),
  };
}

/**
 * The completeness matrix: each FR-1..8 state transition and the audit action it
 * must emit. The walk below produces every one; the assertion is data-driven off
 * this list so a new transition without an event is caught.
 */
const TRANSITIONS: ReadonlyArray<{ fr: string; label: string; action: string }> = [
  { fr: 'FR-2', label: 'publisher registration', action: 'publisher.register' },
  { fr: 'FR-2', label: 'prefix claim', action: 'prefix.claim' },
  { fr: 'FR-1', label: 'publish intake', action: 'publish.submitted' },
  { fr: 'FR-3', label: 'automated review → reviewing', action: 'review.reviewing' },
  { fr: 'FR-4', label: 'human verdict → approved', action: 'review.approved' },
  { fr: 'FR-4', label: 'human verdict → rejected', action: 'review.rejected' },
  { fr: 'FR-5', label: 'countersign', action: 'release.countersigned' },
  { fr: 'FR-5', label: 'transparency-log emit', action: 'release.logged' },
  { fr: 'FR-8', label: 'revoke', action: 'artifact.revoked' },
  { fr: 'FR-8', label: 'kill', action: 'artifact.killed' },
];

describe('audit-event completeness (FR-12)', () => {
  let issuer: FakeIssuer;
  let authorToken: string;
  let reviewerToken: string;
  let operatorToken: string;
  let reviewerId: string;
  let operatorId: string;
  let logger: ReturnType<typeof createLogger>;
  let audit: AuditEvent[];

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    authorToken = await issuer.sign({ iss: issuer.issuer, sub: AUTHOR_SUB, exp: FUTURE });
    reviewerToken = await issuer.sign({ iss: issuer.issuer, sub: REVIEWER_SUB, exp: FUTURE });
    operatorToken = await issuer.sign({ iss: issuer.issuer, sub: OPERATOR_SUB, exp: FUTURE });
    reviewerId = composeOidcIdentity(issuer.issuer, REVIEWER_SUB);
    operatorId = composeOidcIdentity(issuer.issuer, OPERATOR_SUB);
    logger = createLogger(loadConfig({ LOG_LEVEL: 'silent', REGISTRY_ID }));
  });

  afterAll(async () => {
    await issuer.close();
  });

  beforeEach(() => {
    audit = [];
    setAuditSink({ emit: (event) => audit.push(event) });
  });

  afterEach(() => {
    setAuditSink(noopAuditSink);
  });

  /** Build a fresh app. The author is NOT pre-registered — registration is a transition we audit. */
  async function makeApp() {
    const config = loadConfig({
      LOG_LEVEL: 'silent',
      REGISTRY_ID,
      REVIEW_REVIEWER_IDENTITIES: reviewerId,
      OPS_OPERATOR_IDENTITIES: operatorId,
    });
    const publisherStore = new InMemoryPublisherStore();
    const artifactStore = new InMemoryArtifactStore();
    const reviewCaseStore = new InMemoryReviewCaseStore();
    const app = await buildServer({
      config,
      logger,
      publisherStore,
      artifactStore,
      objectStore: new InMemoryObjectStore(),
      reviewCaseStore,
      releaseDocStore: new InMemoryReleaseDocStore(),
      feedEntryStore: new InMemoryFeedEntryStore(),
      countersignIdentity: makeCountersignIdentity(),
      oidcVerifier: createOidcVerifier({ issuerAllowlist: [issuer.issuer] }),
    });
    return { app, publisherStore, artifactStore, reviewCaseStore };
  }

  type App = Awaited<ReturnType<typeof buildServer>>;

  const registerAuthor = (app: App) =>
    app.inject({
      method: 'POST',
      url: '/v1/publishers',
      headers: { authorization: `Bearer ${authorToken}` },
      payload: { prefix: 'acme', tier: 'operator' },
    });

  const publish = (app: App, version: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/artifacts',
      headers: { authorization: `Bearer ${authorToken}` },
      payload: uploadBody(version),
    });

  async function caseIdFor(app: App, artifactId: string): Promise<string> {
    const queue = await app.inject({
      method: 'GET',
      url: '/v1/review/queue',
      headers: { authorization: `Bearer ${reviewerToken}` },
    });
    return queue.json().cases.find(
      (c: { artifact: { id: string } }) => c.artifact.id === artifactId,
    ).caseId as string;
  }

  const verdict = (app: App, caseId: string, decision: 'approve' | 'reject') =>
    app.inject({
      method: 'POST',
      url: `/v1/review/cases/${caseId}/verdict`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: { decision, findings: [] },
    });

  /**
   * Seed an artifact carrying a publisher envelope whose `releaseHash` actually
   * binds its content hashes (via `makePublisherFixture`), so the approval-time
   * countersign hook publishes a release. HTTP intake now accepts the protocol
   * envelope shape (registry#55), but this test's `uploadBody` envelope uses a
   * placeholder `releaseHash` that does not bind the uploaded bytes, so *its*
   * countersign fails the release-hash binding — a correctly-bound envelope is
   * seeded here to exercise countersign end to end, mirroring `lane-integration.test.ts`.
   */
  async function seedCountersignable(
    artifactStore: Awaited<ReturnType<typeof makeApp>>['artifactStore'],
    reviewCaseStore: Awaited<ReturnType<typeof makeApp>>['reviewCaseStore'],
    publisherId: string,
    version: string,
  ): Promise<string> {
    const fixture = await makePublisherFixture({ artifactId: `acme-clock@${version}` });
    const created = await artifactStore.create({
      publisherId,
      tag: 'acme-clock',
      version,
      contentHashes: fixture.files,
      sourceArchiveRef: null,
      envelope: fixture.publisherEnvelope,
    });
    if (!created.ok) throw new Error('seed failed');
    await artifactStore.transition(created.record.id, 'submitted', 'reviewing');
    await reviewCaseStore.create({ artifactId: created.record.id, checksReport: PASS_REPORT });
    return created.record.id;
  }

  it('emits one audit event for every FR-1..8 state transition', async () => {
    const { app, publisherStore, artifactStore, reviewCaseStore } = await makeApp();

    // FR-2: registration + prefix claim.
    expect((await registerAuthor(app)).statusCode).toBe(201);
    const author = await publisherStore.findByIdentity(issuer.issuer, AUTHOR_SUB);
    expect(author).not.toBeNull();

    // FR-1 → FR-3: HTTP publish → automated review moves it to `reviewing`.
    const approved = await publish(app, '1.0.0');
    expect(approved.json().state).toBe('reviewing');
    const approvedId = approved.json().id as string;
    // FR-4 approve (this one's envelope has a placeholder releaseHash that does not
    // bind its content, so its countersign hook fails silently — the release events
    // come from the seeded, correctly-bound artifact below).
    const approveVerdict = await verdict(app, await caseIdFor(app, approvedId), 'approve');
    expect(approveVerdict.json().artifactState).toBe('approved');

    // FR-4 reject: a second artifact taken to `rejected` by a human verdict.
    const rejected = await publish(app, '2.0.0');
    const rejectedId = rejected.json().id as string;
    const rejectVerdict = await verdict(app, await caseIdFor(app, rejectedId), 'reject');
    expect(rejectVerdict.json().artifactState).toBe('rejected');

    // FR-5 countersign + transparency log: approve a seeded valid-envelope artifact
    // over the same HTTP path, so the production countersign hook publishes a release.
    const countersignId = await seedCountersignable(
      artifactStore,
      reviewCaseStore,
      author!.id,
      '5.0.0',
    );
    const csVerdict = await verdict(app, await caseIdFor(app, countersignId), 'approve');
    expect(csVerdict.json().artifactState).toBe('approved');

    // FR-8 revoke: withdraw the (approved, countersigned) seeded artifact.
    const revoked = await app.inject({
      method: 'POST',
      url: `/v1/ops/artifacts/${countersignId}/revoke`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { severity: 'high', reason: 'audit completeness walk' },
    });
    expect(revoked.statusCode).toBe(201);

    // FR-8 kill: take the first approved artifact straight to killed.
    const killed = await app.inject({
      method: 'POST',
      url: `/v1/ops/artifacts/${approvedId}/kill`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { severity: 'critical', reason: 'audit completeness walk' },
    });
    expect(killed.statusCode).toBe(201);

    // Every transition in the matrix produced its event.
    const actions = new Set(audit.map((event) => event.action));
    const missing = TRANSITIONS.filter((t) => !actions.has(t.action));
    expect(missing, `missing audit events: ${missing.map((m) => m.action).join(', ')}`).toEqual([]);

    // Each event carries the full AuditEvent shape.
    for (const event of audit) {
      expect(event.actor).toBeTypeOf('string');
      expect(event.action).toBeTypeOf('string');
      expect(event.subject).toBeTypeOf('string');
      expect(event.at).toBeInstanceOf(Date);
    }

    await app.close();
  });

  it('emits no per-request audit event for the read surfaces (serving, resolution)', async () => {
    const { app } = await makeApp();
    await registerAuthor(app);
    audit = []; // ignore the registration events; measure only the reads below.

    // Serving (hash read) and resolution (import-map fragment) are hot-path reads,
    // not state transitions — neither writes to the audit trail.
    await app.inject({ method: 'GET', url: '/v1/artifacts/sha2-256:deadbeef' });
    await app.inject({ method: 'GET', url: '/v1/releases/sha2-256:deadbeef' });
    await app.inject({
      method: 'POST',
      url: '/v1/resolve',
      payload: { widgets: [{ publisher: 'acme', tag: 'acme-clock' }] },
    });

    expect(audit).toEqual([]);
    await app.close();
  });
});
