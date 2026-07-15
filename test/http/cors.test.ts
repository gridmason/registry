/**
 * CORS on the anonymous public surfaces (#57): a browser host (the dashboard, any
 * embedding app) is cross-origin, so the anonymous distribution surfaces must send
 * wildcard CORS + answer preflight, while the authenticated control plane must
 * NOT — a cross-origin browser call to it stays blocked.
 *
 * The suite drives the **real** `buildServer` wiring over `inject()` with
 * in-memory stores, so the allowlist in `src/http/cors.ts` is verified against the
 * routes actually mounted — a public route missing from it, or an authenticated
 * route wrongly added, fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { noopAuditSink, setAuditSink } from '../../src/audit/index.js';
import { loadConfig } from '../../src/config/index.js';
import { loadCountersignIdentity } from '../../src/countersign/identity.js';
import { PUBLIC_CORS_ROUTES } from '../../src/http/cors.js';
import { createLogger } from '../../src/logging/index.js';
import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import { InMemoryReleaseDocStore } from '../../src/release/store.js';
import { InMemoryReviewCaseStore } from '../../src/review/store.js';
import { InMemoryFeedEntryStore } from '../../src/revocation/store.js';
import { buildServer } from '../../src/server.js';
import { InMemoryTransparencyLog } from '../../src/sigstore/log.js';
import { InMemoryObjectStore } from '../../src/storage/object-store.js';
import { makeCountersignFixture } from '../countersign/fixtures/envelope.js';

const REGISTRY_ID = 'registry.test';
const ORIGIN = 'http://localhost:5173'; // the local dashboard, the acceptance scenario

/** A concrete request URL for each public route template (params filled with dummies). */
const PUBLIC_REQUESTS: ReadonlyArray<{ method: 'GET' | 'POST'; template: string; url: string; body?: object }> = [
  { method: 'POST', template: '/v1/resolve', url: '/v1/resolve', body: { registry: REGISTRY_ID, modules: [] } },
  { method: 'GET', template: '/v1/widgets', url: '/v1/widgets' },
  { method: 'GET', template: '/v1/revocation/feed', url: '/v1/revocation/feed' },
  { method: 'GET', template: '/v1/artifacts/:hash', url: '/v1/artifacts/sha2-256:deadbeef' },
  { method: 'GET', template: '/v1/releases/:hash', url: '/v1/releases/sha2-256:deadbeef' },
  { method: 'GET', template: '/v1/publishers/:id', url: '/v1/publishers/nobody' },
  { method: 'GET', template: '/v1/prefixes/:prefix', url: '/v1/prefixes/nobody' },
];

/** Authenticated control-plane routes that must stay non-CORS. */
const AUTHED_REQUESTS: ReadonlyArray<{ method: 'GET' | 'POST'; url: string }> = [
  { method: 'POST', url: '/v1/publishers' },
  { method: 'POST', url: '/v1/artifacts' },
  { method: 'GET', url: '/v1/artifacts/art-1/status' },
  { method: 'POST', url: '/v1/artifacts/art-1/appeal' },
  { method: 'GET', url: '/v1/review/queue' },
  { method: 'POST', url: '/v1/ops/artifacts/art-1/kill' },
  { method: 'POST', url: '/v1/ops/artifacts/art-1/revoke' },
];

let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  setAuditSink(noopAuditSink);
  const config = loadConfig({ LOG_LEVEL: 'silent', REGISTRY_ID });
  app = await buildServer({
    config,
    logger: createLogger(config),
    publisherStore: new InMemoryPublisherStore(),
    artifactStore: new InMemoryArtifactStore(),
    objectStore: new InMemoryObjectStore(),
    reviewCaseStore: new InMemoryReviewCaseStore(),
    releaseDocStore: new InMemoryReleaseDocStore(),
    feedEntryStore: new InMemoryFeedEntryStore(),
    countersignIdentity: loadCountersignIdentity(makeCountersignFixture())!,
    transparencyLog: new InMemoryTransparencyLog(REGISTRY_ID),
  });
});

afterAll(async () => {
  await app.close();
  setAuditSink(noopAuditSink);
});

const preflight = (url: string, method: string) =>
  app.inject({
    method: 'OPTIONS',
    url,
    headers: { origin: ORIGIN, 'access-control-request-method': method, 'access-control-request-headers': 'content-type' },
  });

describe('CORS — anonymous public surfaces', () => {
  it.each(PUBLIC_REQUESTS)('answers preflight for $method $template with wildcard + methods/headers/max-age', async (r) => {
    const res = await preflight(r.url, r.method);
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain(r.method);
    expect(res.headers['access-control-allow-methods']).toContain('OPTIONS');
    expect(res.headers['access-control-allow-headers']).toContain('content-type');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it.each(PUBLIC_REQUESTS)('stamps the actual $method $template response with wildcard + expose-headers', async (r) => {
    const res = await app.inject({
      method: r.method,
      url: r.url,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: r.body,
    });
    // The header is present regardless of the response status (even a 404/400 body
    // must be readable cross-origin), because it is set before the handler runs.
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const expose = String(res.headers['access-control-expose-headers'] ?? '');
    expect(expose).toContain('etag');
    expect(expose).toContain('x-request-id');
  });
});

describe('CORS — authenticated control plane stays closed', () => {
  it.each(AUTHED_REQUESTS)('sends no CORS header on the actual $method $url response', async (r) => {
    const res = await app.inject({ method: r.method, url: r.url, headers: { origin: ORIGIN } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });

  it.each(AUTHED_REQUESTS)('has no preflight handler for $method $url (browser blocks it)', async (r) => {
    const res = await preflight(r.url, r.method);
    expect(res.statusCode).toBe(404);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS allowlist', () => {
  it('contains only anonymous routes — no /v1/publishers POST, no /v1/ops, no /status/appeal/review', () => {
    for (const route of PUBLIC_CORS_ROUTES) {
      expect(route.url.startsWith('/v1/ops/')).toBe(false);
      expect(route.url).not.toBe('/v1/artifacts'); // the authenticated upload
      expect(route.url.endsWith('/status')).toBe(false);
      expect(route.url.endsWith('/appeal')).toBe(false);
      expect(route.url.startsWith('/v1/review/')).toBe(false);
    }
    // The `POST /v1/publishers` registration must not be exposed even though the
    // `GET /v1/publishers/:id` read is.
    expect(PUBLIC_CORS_ROUTES.some((r) => r.method === 'POST' && r.url === '/v1/publishers')).toBe(false);
  });
});
