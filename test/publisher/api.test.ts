import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AuditEvent } from '../../src/audit/index.js';
import { noopAuditSink, setAuditSink } from '../../src/audit/index.js';
import { createOidcVerifier } from '../../src/auth/oidc.js';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import { buildServer } from '../../src/server.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';

const REGISTRY_ID = 'registry.test';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

const config = loadConfig({ LOG_LEVEL: 'silent', REGISTRY_ID });
const logger = createLogger(config);

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('publisher API', () => {
  let issuer: FakeIssuer;
  let validToken: string;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let store: InMemoryPublisherStore;
  let audit: AuditEvent[];

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    validToken = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
  });

  afterAll(async () => {
    await issuer.close();
  });

  beforeEach(async () => {
    store = new InMemoryPublisherStore();
    const verifier = createOidcVerifier({ issuerAllowlist: [issuer.issuer] });
    app = await buildServer({ config, logger, publisherStore: store, oidcVerifier: verifier });
    audit = [];
    setAuditSink({ emit: (event) => audit.push(event) });
  });

  afterEach(async () => {
    setAuditSink(noopAuditSink);
    await app.close();
  });

  it('registers a publisher, returning a source-qualified record and emitting audit events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/publishers',
      headers: auth(validToken),
      payload: { prefix: 'acme', tier: 'verified' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      registryId: REGISTRY_ID,
      identity: { issuer: issuer.issuer, subject: 'user-1' },
      prefix: 'acme',
      tier: 'verified',
      publishedVersions: [],
      reviewHistory: [],
    });
    expect(typeof body.id).toBe('string');

    expect(audit.map((e) => e.action)).toEqual(['publisher.register', 'prefix.claim']);
    const claim = audit.find((e) => e.action === 'prefix.claim');
    expect(claim?.subject).toBe(`${REGISTRY_ID}/acme`);
    expect(claim?.actor).toBe(`${issuer.issuer} user-1`);
  });

  it('defaults an omitted tier to community', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/publishers',
      headers: auth(validToken),
      payload: { prefix: 'acme' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().tier).toBe('community');
  });

  it('rejects a prefix already claimed on this registry with 409', async () => {
    await store.register({ issuer: issuer.issuer, subject: 'other', prefix: 'acme', tier: 'community' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/publishers',
      headers: auth(validToken),
      payload: { prefix: 'acme' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('prefix_taken');
  });

  it('rejects a token from a non-allowlisted issuer with 403 and audits the denial', async () => {
    const token = await issuer.sign({ iss: 'https://evil.example', sub: 'user-1', exp: FUTURE });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/publishers',
      headers: auth(token),
      payload: { prefix: 'acme' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('issuer_not_allowed');
    expect(audit).toEqual([
      expect.objectContaining({
        actor: 'anonymous',
        action: 'publisher.register.denied',
        subject: 'register:issuer-not-allowed',
      }),
    ]);
  });

  it('rejects a token whose signature does not verify with 401 and audits the denial', async () => {
    const token = await issuer.signWithWrongKey({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/publishers',
      headers: auth(token),
      payload: { prefix: 'acme' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_token');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'publisher.register.denied',
        subject: 'register:invalid-signature',
      }),
    ]);
  });

  it('rejects a missing bearer token with 401 without auditing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/publishers',
      payload: { prefix: 'acme' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('missing_token');
    expect(audit).toHaveLength(0);
  });

  it('rejects an expired token with 401', async () => {
    const token = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: 1000 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/publishers',
      headers: auth(token),
      payload: { prefix: 'acme' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('token_expired');
  });

  it('rejects an invalid prefix with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/publishers',
      headers: auth(validToken),
      payload: { prefix: 'Acme_Corp' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_prefix');
  });

  it('rejects a missing prefix with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/publishers',
      headers: auth(validToken),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('reads a publisher record by id, source-qualified', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/publishers',
      headers: auth(validToken),
      payload: { prefix: 'acme' },
    });
    const { id } = created.json();

    const res = await app.inject({ method: 'GET', url: `/v1/publishers/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, registryId: REGISTRY_ID, prefix: 'acme' });
  });

  it('reads prefix ownership, source-qualified', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/publishers',
      headers: auth(validToken),
      payload: { prefix: 'acme' },
    });

    const res = await app.inject({ method: 'GET', url: '/v1/prefixes/acme' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      prefix: 'acme',
      registryId: REGISTRY_ID,
      owner: { issuer: issuer.issuer, subject: 'user-1' },
    });
  });

  it('returns 404 for an unknown publisher and prefix', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/publishers/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/prefixes/nope' })).statusCode).toBe(404);
  });
});
