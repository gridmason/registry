/**
 * Revocation & kill feed API (#14, FR-8, FR-12) end to end, over the HTTP surface
 * with `inject()`, in-memory stores, and a live FakeIssuer.
 *
 * Drives the full authority path: publish → automated review → human approval →
 * operator kill/revoke → the anonymous signed feed. Asserts the issue's acceptance
 * criteria: a kill flips the feed within one cycle (seq strictly increases, entry
 * visible on the next fetch), `evaluateFreshness` accepts the served feed, a killed
 * artifact is excluded from the approved (resolution-candidate) set, revoke/kill are
 * distinct states carrying severity + reason, and each emits an `AuditEvent`.
 */
import { sign } from 'node:crypto';

import { evaluateFreshness, type Cursor } from '@gridmason/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import type { AuditEvent } from '../../src/audit/index.js';
import { noopAuditSink, setAuditSink } from '../../src/audit/index.js';
import { createOidcVerifier } from '../../src/auth/oidc.js';
import { loadConfig } from '../../src/config/index.js';
import type { CountersignIdentity } from '../../src/countersign/identity.js';
import { createLogger } from '../../src/logging/index.js';
import { composeOidcIdentity } from '../../src/publisher/types.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import { InMemoryReviewCaseStore } from '../../src/review/store.js';
import { InMemoryFeedEntryStore } from '../../src/revocation/store.js';
import { buildServer } from '../../src/server.js';
import { InMemoryObjectStore } from '../../src/storage/object-store.js';
import { buildLeafCertificate, generateP256, spkiDer } from '../countersign/fixtures/certs.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';

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

/** A countersign identity backed by a self-signed P-256 leaf (the feed signing key). */
function makeCountersignIdentity(): CountersignIdentity {
  const { publicKey, privateKey } = generateP256();
  return {
    sign: (message) =>
      new Uint8Array(sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' })),
    certificateDer: buildLeafCertificate({ subjectPublicKey: publicKey, issuerPrivateKey: privateKey }),
    publicKeySpkiDer: spkiDer(publicKey),
  };
}

describe('revocation & kill feed API', () => {
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
    const cfg = loadConfig({ LOG_LEVEL: 'silent', REGISTRY_ID });
    logger = createLogger(cfg);
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

  /** Build a fresh app with the reviewer + operator sets and the author registered. */
  async function makeApp() {
    const publisherStore = new InMemoryPublisherStore();
    await publisherStore.register({
      issuer: issuer.issuer,
      subject: AUTHOR_SUB,
      prefix: 'acme',
      tier: 'operator',
    });
    const artifactStore = new InMemoryArtifactStore();
    const config = loadConfig({
      LOG_LEVEL: 'silent',
      REGISTRY_ID,
      REVIEW_REVIEWER_IDENTITIES: reviewerId,
      OPS_OPERATOR_IDENTITIES: operatorId,
    });
    const app = await buildServer({
      config,
      logger,
      publisherStore,
      artifactStore,
      objectStore: new InMemoryObjectStore(),
      reviewCaseStore: new InMemoryReviewCaseStore(),
      feedEntryStore: new InMemoryFeedEntryStore(),
      countersignIdentity: makeCountersignIdentity(),
      oidcVerifier: createOidcVerifier({ issuerAllowlist: [issuer.issuer] }),
    });
    return { app, artifactStore };
  }

  /** Publish version `v` and approve it, returning the approved artifact id. */
  async function publishAndApprove(app: Awaited<ReturnType<typeof buildServer>>, v: string): Promise<string> {
    const published = await app.inject({
      method: 'POST',
      url: '/v1/artifacts',
      headers: { authorization: `Bearer ${authorToken}` },
      payload: uploadBody(v),
    });
    expect(published.json().state).toBe('reviewing');
    const artifactId = published.json().id as string;
    const queue = await app.inject({
      method: 'GET',
      url: '/v1/review/queue',
      headers: { authorization: `Bearer ${reviewerToken}` },
    });
    const caseId = queue.json().cases.find(
      (c: { artifact: { id: string } }) => c.artifact.id === artifactId,
    ).caseId as string;
    const verdict = await app.inject({
      method: 'POST',
      url: `/v1/review/cases/${caseId}/verdict`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: { decision: 'approve', findings: [] },
    });
    expect(verdict.json().artifactState).toBe('approved');
    return artifactId;
  }

  const getFeed = (app: Awaited<ReturnType<typeof buildServer>>) =>
    app.inject({ method: 'GET', url: '/v1/revocation/feed' });

  const kill = (app: Awaited<ReturnType<typeof buildServer>>, id: string, token: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url: `/v1/ops/artifacts/${id}/kill`,
      headers: { authorization: `Bearer ${token}` },
      payload: body as Record<string, unknown>,
    });

  const revoke = (app: Awaited<ReturnType<typeof buildServer>>, id: string, token: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url: `/v1/ops/artifacts/${id}/revoke`,
      headers: { authorization: `Bearer ${token}` },
      payload: body as Record<string, unknown>,
    });

  it('serves an anonymous signed feed evaluateFreshness accepts (empty at first)', async () => {
    const { app } = await makeApp();
    const res = await getFeed(app);
    expect(res.statusCode).toBe(200);
    const { feed, signature } = res.json();
    expect(feed.registryId).toBe(REGISTRY_ID);
    expect(feed.seq).toBe(0);
    expect(feed.entries).toEqual([]);
    expect(signature.alg).toBe('ES256');
    expect(typeof signature.cert).toBe('string');

    const cursor: Cursor = { registryId: REGISTRY_ID, seq: -1 };
    const verdict = evaluateFreshness(feed, cursor, feed.issuedAt + 1000);
    expect(verdict.code).toBe('fresh');
    await app.close();
  });

  it('kill flips the feed within one cycle: seq increases, entry visible, artifact excluded from approved', async () => {
    const { app, artifactStore } = await makeApp();
    const artifactId = await publishAndApprove(app, '1.2.0');

    const before = (await getFeed(app)).json().feed;
    expect(before.seq).toBe(0);

    const killed = await kill(app, artifactId, operatorToken, {
      severity: 'critical',
      reason: 'actively exploited credential path',
    });
    expect(killed.statusCode).toBe(201);
    expect(killed.json()).toMatchObject({ artifactState: 'killed', state: 'killed', seq: 1 });

    const after = (await getFeed(app)).json().feed;
    // The feed version strictly increased and the killed artifact is now listed.
    expect(after.seq).toBeGreaterThan(before.seq);
    expect(after.entries).toEqual([
      { artifact: 'acme-clock@1.2.0', state: 'killed', severity: 'critical', reason: 'actively exploited credential path' },
    ]);

    // A host would block (and unload) it via the protocol verdict.
    const cursor: Cursor = { registryId: REGISTRY_ID, seq: -1 };
    const verdict = evaluateFreshness(after, cursor, after.issuedAt + 1000);
    expect(verdict.blocked).toEqual([
      { artifact: 'acme-clock@1.2.0', state: 'killed', severity: 'critical' },
    ]);

    // Excluded from the approved (resolution-candidate) set — never enters an import map.
    expect(await artifactStore.listByState('approved')).toHaveLength(0);
    // A kill audit event was emitted, attributed to the operator, naming the artifact.
    expect(audit.find((e) => e.action === 'artifact.killed')).toMatchObject({
      actor: operatorId,
      subject: artifactId,
    });
    await app.close();
  });

  it('revoke and kill are distinct states; both carry severity + reason and audit', async () => {
    const { app } = await makeApp();
    const first = await publishAndApprove(app, '1.2.0');
    const second = await publishAndApprove(app, '1.3.0');

    const rev = await revoke(app, first, operatorToken, { severity: 'medium', reason: 'deprecated api' });
    expect(rev.statusCode).toBe(201);
    expect(rev.json()).toMatchObject({ artifactState: 'revoked', state: 'revoked' });
    const kil = await kill(app, second, operatorToken, { severity: 'high', reason: 'data leak' });
    expect(kil.statusCode).toBe(201);

    const feed = (await getFeed(app)).json().feed;
    const byArtifact = Object.fromEntries(feed.entries.map((e: { artifact: string }) => [e.artifact, e]));
    expect(byArtifact['acme-clock@1.2.0']).toMatchObject({ state: 'revoked', severity: 'medium', reason: 'deprecated api' });
    expect(byArtifact['acme-clock@1.3.0']).toMatchObject({ state: 'killed', severity: 'high', reason: 'data leak' });
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['artifact.revoked', 'artifact.killed']));
    await app.close();
  });

  it('escalates revoked → killed, advancing the feed', async () => {
    const { app } = await makeApp();
    const id = await publishAndApprove(app, '1.2.0');
    const rev = await revoke(app, id, operatorToken, { severity: 'low', reason: 'x' });
    expect(rev.json().seq).toBe(1);
    const kil = await kill(app, id, operatorToken, { severity: 'critical', reason: 'y' });
    expect(kil.statusCode).toBe(201);
    expect(kil.json().seq).toBe(2);
    const feed = (await getFeed(app)).json().feed;
    expect(feed.seq).toBe(2);
    expect(feed.entries).toEqual([
      { artifact: 'acme-clock@1.2.0', state: 'killed', severity: 'critical', reason: 'y' },
    ]);
    await app.close();
  });

  it('rejects a kill of an artifact that is not approved (409) and an unknown id (404)', async () => {
    const { app } = await makeApp();
    const id = await publishAndApprove(app, '1.2.0');
    // First kill succeeds; a second kill of the now-killed artifact is invalid-state.
    expect((await kill(app, id, operatorToken, { severity: 'high', reason: 'a' })).statusCode).toBe(201);
    const again = await kill(app, id, operatorToken, { severity: 'high', reason: 'b' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('invalid_state');

    const missing = await revoke(app, 'no-such-id', operatorToken, { severity: 'low', reason: 'c' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
    await app.close();
  });

  it('validates the request body: bad severity and empty reason are 400', async () => {
    const { app } = await makeApp();
    const id = await publishAndApprove(app, '1.2.0');
    const badSeverity = await kill(app, id, operatorToken, { severity: 'urgent', reason: 'x' });
    expect(badSeverity.statusCode).toBe(400);
    const emptyReason = await kill(app, id, operatorToken, { severity: 'high', reason: '  ' });
    expect(emptyReason.statusCode).toBe(400);
    await app.close();
  });

  it('gates the ops surface: anonymous is 401, a non-operator identity is 403 + audited', async () => {
    const { app } = await makeApp();
    const id = await publishAndApprove(app, '1.2.0');

    const anon = await app.inject({ method: 'POST', url: `/v1/ops/artifacts/${id}/kill`, payload: { severity: 'high', reason: 'x' } });
    expect(anon.statusCode).toBe(401);

    // The reviewer is a verified identity, but not on the operator set.
    const notOperator = await kill(app, id, reviewerToken, { severity: 'high', reason: 'x' });
    expect(notOperator.statusCode).toBe(403);
    expect(notOperator.json().error.code).toBe('not_an_operator');
    expect(audit.map((e) => e.action)).toContain('ops.denied');
    await app.close();
  });
});
