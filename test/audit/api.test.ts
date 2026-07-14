/**
 * Audit-query endpoint (#15, FR-12): `GET /v1/ops/audit`, operator-gated, over the
 * HTTP surface with `inject()`. Covers the filter contract (subject, action, time
 * range), keyset pagination, and the operator auth boundary (401/403) — the read
 * half of FR-12 that makes the emitted trail retrievable.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { emitAuditEvent, noopAuditSink, setAuditSink } from '../../src/audit/index.js';
import { InMemoryAuditStore } from '../../src/audit/query.js';
import { createOidcVerifier } from '../../src/auth/oidc.js';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';
import { composeOidcIdentity } from '../../src/publisher/types.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import { buildServer } from '../../src/server.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';

const REGISTRY_ID = 'registry.test';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const OPERATOR_SUB = 'operator-1';
const STRANGER_SUB = 'stranger-1';

describe('audit-query endpoint', () => {
  let issuer: FakeIssuer;
  let operatorToken: string;
  let strangerToken: string;
  let operatorId: string;
  let logger: ReturnType<typeof createLogger>;
  let store: InMemoryAuditStore;

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

  beforeEach(() => {
    store = new InMemoryAuditStore();
    // Install the same store as the active audit sink, so events emitted below land
    // in exactly the collection the endpoint queries — FR-12's two halves over one store.
    setAuditSink(store);
  });

  afterEach(() => {
    setAuditSink(noopAuditSink);
  });

  async function makeApp() {
    const config = loadConfig({
      LOG_LEVEL: 'silent',
      REGISTRY_ID,
      OPS_OPERATOR_IDENTITIES: operatorId,
    });
    return buildServer({
      config,
      logger,
      // The endpoint mounts inside the publisher-store block (it shares the verifier).
      publisherStore: new InMemoryPublisherStore(),
      auditQueryStore: store,
      oidcVerifier: createOidcVerifier({ issuerAllowlist: [issuer.issuer] }),
    });
  }

  type App = Awaited<ReturnType<typeof buildServer>>;

  const query = (app: App, qs: string, token = operatorToken) =>
    app.inject({
      method: 'GET',
      url: `/v1/ops/audit${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it('rejects a missing token (401) and a non-operator (403)', async () => {
    const app = await makeApp();
    const anon = await app.inject({ method: 'GET', url: '/v1/ops/audit' });
    expect(anon.statusCode).toBe(401);
    const stranger = await query(app, '', strangerToken);
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error.code).toBe('not_an_operator');
    await app.close();
  });

  it('returns every event newest-first for an operator', async () => {
    const app = await makeApp();
    emitAuditEvent('pub-1', 'publish.submitted', 'artifact-1');
    emitAuditEvent('system', 'review.reviewing', 'artifact-1');
    emitAuditEvent('rev-1', 'review.approved', 'artifact-1');

    const res = await query(app, '');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events.map((e: { action: string }) => e.action)).toEqual([
      'review.approved',
      'review.reviewing',
      'publish.submitted',
    ]);
    expect(body.events[0]).toMatchObject({ actor: 'rev-1', subject: 'artifact-1' });
    expect(typeof body.events[0].at).toBe('string');
    expect(body.nextBefore).toBeNull();
    await app.close();
  });

  it('filters by subject and by action', async () => {
    const app = await makeApp();
    emitAuditEvent('pub-1', 'publish.submitted', 'artifact-1');
    emitAuditEvent('pub-2', 'publish.submitted', 'artifact-2');
    emitAuditEvent('op-1', 'artifact.killed', 'artifact-1');

    const bySubject = await query(app, '?subject=artifact-1');
    expect(bySubject.json().events.map((e: { action: string }) => e.action)).toEqual([
      'artifact.killed',
      'publish.submitted',
    ]);

    const byAction = await query(app, '?action=publish.submitted');
    expect(byAction.json().events.map((e: { subject: string }) => e.subject)).toEqual([
      'artifact-2',
      'artifact-1',
    ]);

    const both = await query(app, '?subject=artifact-1&action=artifact.killed');
    expect(both.json().events).toHaveLength(1);
    await app.close();
  });

  it('filters by time range (since/until, inclusive)', async () => {
    const app = await makeApp();
    emitAuditEvent('a', 'x', 's', new Date('2026-01-01T00:00:00.000Z'));
    emitAuditEvent('a', 'x', 's', new Date('2026-06-01T00:00:00.000Z'));
    emitAuditEvent('a', 'x', 's', new Date('2026-12-01T00:00:00.000Z'));

    const windowed = await query(
      app,
      '?since=2026-03-01T00:00:00.000Z&until=2026-09-01T00:00:00.000Z',
    );
    const times = windowed.json().events.map((e: { at: string }) => e.at);
    expect(times).toEqual(['2026-06-01T00:00:00.000Z']);
    await app.close();
  });

  it('rejects a malformed timestamp with 400', async () => {
    const app = await makeApp();
    const res = await query(app, '?since=not-a-date');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
    await app.close();
  });

  it('paginates via limit + the nextBefore cursor', async () => {
    const app = await makeApp();
    for (let i = 0; i < 5; i++) emitAuditEvent('a', 'x', `subject-${i}`);

    const page1 = await query(app, '?limit=2');
    const b1 = page1.json();
    expect(b1.events.map((e: { subject: string }) => e.subject)).toEqual(['subject-4', 'subject-3']);
    expect(b1.nextBefore).not.toBeNull();

    const page2 = await query(app, `?limit=2&before=${b1.nextBefore}`);
    const b2 = page2.json();
    expect(b2.events.map((e: { subject: string }) => e.subject)).toEqual(['subject-2', 'subject-1']);

    const page3 = await query(app, `?limit=2&before=${b2.nextBefore}`);
    const b3 = page3.json();
    // The final (short) page carries the last event and closes the cursor.
    expect(b3.events.map((e: { subject: string }) => e.subject)).toEqual(['subject-0']);
    expect(b3.nextBefore).toBeNull();
    await app.close();
  });
});
