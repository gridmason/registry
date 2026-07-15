/**
 * Human review lane API (#9, FR-4) end to end: publish → automated review →
 * queue → verdict, over the HTTP surface with `inject()`, in-memory stores, and a
 * live FakeIssuer. Covers the queue lifecycle, findings→check-id mapping,
 * reviewer≠author enforcement, the disclosed flagship waiver, and reviewer
 * authorization (SPEC §4, §4a).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryArtifactStore } from '../../../src/artifact/store.js';
import type { AuditEvent } from '../../../src/audit/index.js';
import { noopAuditSink, setAuditSink } from '../../../src/audit/index.js';
import { createOidcVerifier } from '../../../src/auth/oidc.js';
import { loadConfig } from '../../../src/config/index.js';
import { createLogger } from '../../../src/logging/index.js';
import { composeOidcIdentity } from '../../../src/publisher/types.js';
import { InMemoryPublisherStore } from '../../../src/publisher/store.js';
import { InMemoryReviewCaseStore } from '../../../src/review/store.js';
import { buildServer } from '../../../src/server.js';
import { InMemoryObjectStore } from '../../../src/storage/object-store.js';
import { startFakeIssuer, type FakeIssuer } from '../../helpers/oidc-issuer.js';

const REGISTRY_ID = 'registry.test';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const AUTHOR_SUB = 'author-1';
const REVIEWER_SUB = 'reviewer-1';
const STRANGER_SUB = 'stranger-1';

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

const validManifest = {
  formatVersion: '1.0',
  tag: 'acme-clock',
  kind: 'widget',
  name: 'Acme Clock',
  publisher: 'acme',
  version: '1.2.0',
  entry: 'entry.js',
};

function uploadBody(): Record<string, unknown> {
  return {
    tag: 'acme-clock',
    version: '1.2.0',
    files: [
      { path: 'manifest.json', role: 'manifest', bytes: b64json(validManifest) },
      { path: 'entry.js', role: 'entry', bytes: b64('export default class extends HTMLElement {}') },
    ],
    sourceArchive: b64('source-tarball'),
    envelope: validEnvelope,
  };
}

describe('human review lane API', () => {
  let issuer: FakeIssuer;
  let authorToken: string;
  let reviewerToken: string;
  let strangerToken: string;
  let authorId: string;
  let reviewerId: string;
  let logger: ReturnType<typeof createLogger>;
  let audit: AuditEvent[];

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    authorToken = await issuer.sign({ iss: issuer.issuer, sub: AUTHOR_SUB, exp: FUTURE });
    reviewerToken = await issuer.sign({ iss: issuer.issuer, sub: REVIEWER_SUB, exp: FUTURE });
    strangerToken = await issuer.sign({ iss: issuer.issuer, sub: STRANGER_SUB, exp: FUTURE });
    authorId = composeOidcIdentity(issuer.issuer, AUTHOR_SUB);
    reviewerId = composeOidcIdentity(issuer.issuer, REVIEWER_SUB);
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

  /** Build a fresh app with the given reviewer set + waiver, author pre-registered. */
  async function makeApp(options: { reviewers: readonly string[]; waiver: boolean }) {
    const publisherStore = new InMemoryPublisherStore();
    await publisherStore.register({
      issuer: issuer.issuer,
      subject: AUTHOR_SUB,
      prefix: 'acme',
      tier: 'operator',
    });
    const artifactStore = new InMemoryArtifactStore();
    const reviewCaseStore = new InMemoryReviewCaseStore();
    const config = loadConfig({
      LOG_LEVEL: 'silent',
      REGISTRY_ID,
      REVIEW_REVIEWER_IDENTITIES: options.reviewers.join(','),
      REVIEW_SELF_REVIEW_WAIVER: options.waiver ? 'true' : 'false',
    });
    const app = await buildServer({
      config,
      logger,
      publisherStore,
      artifactStore,
      objectStore: new InMemoryObjectStore(),
      reviewCaseStore,
      oidcVerifier: createOidcVerifier({ issuerAllowlist: [issuer.issuer] }),
    });
    return { app, artifactStore, reviewCaseStore };
  }

  const publish = (app: Awaited<ReturnType<typeof buildServer>>) =>
    app.inject({
      method: 'POST',
      url: '/v1/artifacts',
      headers: { authorization: `Bearer ${authorToken}` },
      payload: uploadBody(),
    });

  const getQueue = (app: Awaited<ReturnType<typeof buildServer>>, token: string) =>
    app.inject({ method: 'GET', url: '/v1/review/queue', headers: { authorization: `Bearer ${token}` } });

  const getCase = (app: Awaited<ReturnType<typeof buildServer>>, id: string, token: string) =>
    app.inject({ method: 'GET', url: `/v1/review/cases/${id}`, headers: { authorization: `Bearer ${token}` } });

  const submitVerdict = (
    app: Awaited<ReturnType<typeof buildServer>>,
    id: string,
    token: string,
    body: unknown,
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/review/cases/${id}/verdict`,
      headers: { authorization: `Bearer ${token}` },
      payload: body as Record<string, unknown>,
    });

  it('runs the queue lifecycle: publish → queue → case → approve', async () => {
    const { app, artifactStore } = await makeApp({ reviewers: [reviewerId], waiver: false });
    const published = await publish(app);
    expect(published.json().state).toBe('reviewing');
    const artifactId = published.json().id as string;

    // The reviewer sees exactly one pending case, for this artifact.
    const queue = await getQueue(app, reviewerToken);
    expect(queue.statusCode).toBe(200);
    expect(queue.json().cases).toHaveLength(1);
    const caseId = queue.json().cases[0].caseId as string;
    expect(queue.json().cases[0].artifact.id).toBe(artifactId);
    expect(queue.json().cases[0].checks.status).toBe('pass');
    expect(queue.json().cases[0].checks.checkIds).toContain('manifest.schema');

    // The single-case view carries the full report.
    const detail = await getCase(app, caseId, reviewerToken);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().report.results.map((r: { id: string }) => r.id)).toContain('manifest.schema');
    expect(detail.json().verdict).toBeNull();

    // Approve with a finding mapped to a real check id.
    const verdict = await submitVerdict(app, caseId, reviewerToken, {
      decision: 'approve',
      findings: [{ checkId: 'manifest.schema', detail: 'schema is clean' }],
    });
    expect(verdict.statusCode).toBe(201);
    expect(verdict.json()).toMatchObject({ decision: 'approved', artifactState: 'approved', waiverUsed: false });

    // Artifact moved to approved; a verdict audit event was emitted.
    const stored = await artifactStore.findById(artifactId);
    expect(stored?.state).toBe('approved');
    expect(audit.map((e) => e.action)).toContain('review.approved');
    expect(audit.find((e) => e.action === 'review.approved')).toMatchObject({
      actor: reviewerId,
      subject: artifactId,
    });
    await app.close();
  });

  it('rejects → artifact rejected', async () => {
    const { app, artifactStore } = await makeApp({ reviewers: [reviewerId], waiver: false });
    const artifactId = (await publish(app)).json().id as string;
    const caseId = (await getQueue(app, reviewerToken)).json().cases[0].caseId as string;

    const verdict = await submitVerdict(app, caseId, reviewerToken, {
      decision: 'reject',
      findings: [{ checkId: 'manual', detail: 'fails our policy on undisclosed telemetry' }],
    });
    expect(verdict.statusCode).toBe(201);
    expect(verdict.json().artifactState).toBe('rejected');
    expect((await artifactStore.findById(artifactId))?.state).toBe('rejected');
    expect(audit.map((e) => e.action)).toContain('review.rejected');
    await app.close();
  });

  it('maps findings to check ids: real id + `manual` accepted, unknown id → 422', async () => {
    const { app } = await makeApp({ reviewers: [reviewerId], waiver: false });
    await publish(app);
    const caseId = (await getQueue(app, reviewerToken)).json().cases[0].caseId as string;

    const bad = await submitVerdict(app, caseId, reviewerToken, {
      decision: 'reject',
      findings: [{ checkId: 'not.a.real.check', detail: 'x' }],
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('unknown_check_id');

    // The rejected verdict left the case pending, so a valid one still lands.
    const good = await submitVerdict(app, caseId, reviewerToken, {
      decision: 'approve',
      findings: [
        { checkId: 'manifest.schema', detail: 'ok' },
        { checkId: 'manual', detail: 'looks fine by hand too' },
      ],
    });
    expect(good.statusCode).toBe(201);
    expect(good.json().findings).toEqual([
      { checkId: 'manifest.schema', detail: 'ok' },
      { checkId: 'manual', detail: 'looks fine by hand too' },
    ]);
    await app.close();
  });

  it('blocks self-review when the waiver is off (reviewer ≠ author)', async () => {
    // The author is also on the reviewer set, but the waiver is off.
    const { app, artifactStore } = await makeApp({ reviewers: [authorId], waiver: false });
    const artifactId = (await publish(app)).json().id as string;
    const caseId = (await getQueue(app, authorToken)).json().cases[0].caseId as string;

    const verdict = await submitVerdict(app, caseId, authorToken, {
      decision: 'approve',
      findings: [],
    });
    expect(verdict.statusCode).toBe(403);
    expect(verdict.json().error.code).toBe('self_review_forbidden');
    // The artifact is untouched — still awaiting review.
    expect((await artifactStore.findById(artifactId))?.state).toBe('reviewing');
    await app.close();
  });

  it('permits operator self-approval under the waiver and records + audits it', async () => {
    const { app, artifactStore, reviewCaseStore } = await makeApp({
      reviewers: [authorId],
      waiver: true,
    });
    const artifactId = (await publish(app)).json().id as string;
    const caseId = (await getQueue(app, authorToken)).json().cases[0].caseId as string;

    const verdict = await submitVerdict(app, caseId, authorToken, {
      decision: 'approve',
      findings: [{ checkId: 'manual', detail: 'operator self-review under launch waiver' }],
    });
    expect(verdict.statusCode).toBe(201);
    expect(verdict.json().waiverUsed).toBe(true);
    expect((await artifactStore.findById(artifactId))?.state).toBe('approved');

    // The waiver use is persisted on the case so the release can be flagged (§4a).
    const stored = await reviewCaseStore.findById(caseId);
    expect(stored?.waiverUsed).toBe(true);
    expect(stored?.reviewer).toBe(authorId);

    // The waiver use gets its own audit event, distinct from the verdict.
    const actions = audit.map((e) => e.action);
    expect(actions).toContain('review.waiver');
    expect(actions).toContain('review.approved');
    await app.close();
  });

  it('refuses a verified identity that is not on the reviewer set', async () => {
    const { app } = await makeApp({ reviewers: [reviewerId], waiver: false });
    await publish(app);
    const caseId = (await getQueue(app, reviewerToken)).json().cases[0].caseId as string;

    const verdict = await submitVerdict(app, caseId, strangerToken, {
      decision: 'approve',
      findings: [],
    });
    expect(verdict.statusCode).toBe(403);
    expect(verdict.json().error.code).toBe('not_a_reviewer');
    expect(audit.map((e) => e.action)).toContain('review.denied');
    await app.close();
  });

  it('refuses the queue endpoint without a bearer token', async () => {
    const { app } = await makeApp({ reviewers: [reviewerId], waiver: false });
    const res = await app.inject({ method: 'GET', url: '/v1/review/queue' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('missing_token');
    await app.close();
  });

  it('refuses a second verdict on an already-decided case (409)', async () => {
    const { app } = await makeApp({ reviewers: [reviewerId], waiver: false });
    await publish(app);
    const caseId = (await getQueue(app, reviewerToken)).json().cases[0].caseId as string;

    const first = await submitVerdict(app, caseId, reviewerToken, { decision: 'approve', findings: [] });
    expect(first.statusCode).toBe(201);
    // The artifact already left `reviewing`, so the second attempt is not-in-review.
    const second = await submitVerdict(app, caseId, reviewerToken, { decision: 'reject', findings: [] });
    expect(second.statusCode).toBe(409);
    await app.close();
  });
});
