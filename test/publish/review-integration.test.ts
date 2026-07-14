/**
 * Publish → automated-review integration (#8 over #7): with the review stage
 * wired (as the real service always wires it), a successful upload is reviewed
 * before the response — the artifact comes back `reviewing` on a clean run or
 * `rejected` on a hard failure, the checks report is persisted on a review case,
 * and each transition is audited.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import type { AuditEvent } from '../../src/audit/index.js';
import { noopAuditSink, setAuditSink } from '../../src/audit/index.js';
import { createOidcVerifier } from '../../src/auth/oidc.js';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import { InMemoryReviewCaseStore } from '../../src/review/store.js';
import { buildServer } from '../../src/server.js';
import { InMemoryObjectStore } from '../../src/storage/object-store.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';

const REGISTRY_ID = 'registry.test';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

const config = loadConfig({ LOG_LEVEL: 'silent', REGISTRY_ID });
const logger = createLogger(config);

const b64 = (value: string): string => Buffer.from(value).toString('base64');
const b64json = (value: unknown): string => b64(JSON.stringify(value));

const validEnvelope = {
  payloadType: 'application/vnd.gridmason.artifact+json',
  payload: b64('{"tag":"acme-clock"}'),
  signatures: [{ sig: 'MEUCIQ', keyid: 'oidc' }],
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

function uploadBody(manifest: unknown): Record<string, unknown> {
  return {
    tag: 'acme-clock',
    version: '1.2.0',
    files: [
      { path: 'manifest.json', role: 'manifest', bytes: b64json(manifest) },
      { path: 'entry.js', role: 'entry', bytes: b64('export default class extends HTMLElement {}') },
    ],
    sourceArchive: b64('source-tarball'),
    envelope: validEnvelope,
  };
}

describe('publish → automated review', () => {
  let issuer: FakeIssuer;
  let validToken: string;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let artifactStore: InMemoryArtifactStore;
  let reviewCaseStore: InMemoryReviewCaseStore;
  let audit: AuditEvent[];

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    validToken = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
  });

  afterAll(async () => {
    await issuer.close();
  });

  beforeEach(async () => {
    const publisherStore = new InMemoryPublisherStore();
    await publisherStore.register({
      issuer: issuer.issuer,
      subject: 'user-1',
      prefix: 'acme',
      tier: 'verified',
    });
    artifactStore = new InMemoryArtifactStore();
    reviewCaseStore = new InMemoryReviewCaseStore();
    app = await buildServer({
      config,
      logger,
      publisherStore,
      artifactStore,
      objectStore: new InMemoryObjectStore(),
      reviewCaseStore,
      oidcVerifier: createOidcVerifier({ issuerAllowlist: [issuer.issuer] }),
    });
    audit = [];
    setAuditSink({ emit: (event) => audit.push(event) });
  });

  afterEach(async () => {
    setAuditSink(noopAuditSink);
    await app.close();
  });

  async function publish(manifest: unknown) {
    return app.inject({
      method: 'POST',
      url: '/v1/artifacts',
      headers: { authorization: `Bearer ${validToken}` },
      payload: uploadBody(manifest),
    });
  }

  it('reviews a clean upload to `reviewing`, persists the passing report, and audits both transitions', async () => {
    const res = await publish(validManifest);

    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe('reviewing');

    const stored = await artifactStore.findByVersion(res.json().publisherId, 'acme-clock', '1.2.0');
    expect(stored?.state).toBe('reviewing');

    const reviewCase = await reviewCaseStore.findByArtifact(res.json().id);
    expect(reviewCase?.checksReport.status).toBe('pass');
    expect(reviewCase?.checksReport.checksModule).toBe('@gridmason/cli/checks');

    expect(audit.map((e) => e.action)).toEqual(['publish.submitted', 'review.reviewing']);
    expect(audit.at(-1)).toMatchObject({ actor: 'system', subject: res.json().id });
  });

  it('rejects an upload whose manifest requires its own tag (circular requires, SPEC §7)', async () => {
    const res = await publish({
      ...validManifest,
      requires: [{ tag: 'acme-clock', range: '^1.0.0' }],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe('rejected');

    const reviewCase = await reviewCaseStore.findByArtifact(res.json().id);
    expect(reviewCase?.checksReport.status).toBe('fail');
    expect(reviewCase?.checksReport.results).toContainEqual(
      expect.objectContaining({ id: 'deps.acyclic', status: 'fail' }),
    );

    expect(audit.map((e) => e.action)).toEqual(['publish.submitted', 'review.rejected']);
  });
});
