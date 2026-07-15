/**
 * Widget catalog API (#63) over real HTTP: `GET /v1/widgets` lists the
 * **distributable** widgets (approved + countersigned, not revoked/killed — the
 * same predicate resolution gates on), reflects publish→approve, excludes a
 * killed widget, paginates by keyset, and filters by query/publisher. Driven
 * through the real `buildServer` wiring with `inject()`: each widget is seeded and
 * then **approved over HTTP**, so the real countersign stage publishes its release
 * before it can appear in the catalog.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashBytes, type MultihashString } from '@gridmason/protocol';

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
import { InMemoryFeedEntryStore } from '../../src/revocation/store.js';
import { buildServer } from '../../src/server.js';
import { InMemoryTransparencyLog } from '../../src/sigstore/log.js';
import { InMemoryObjectStore } from '../../src/storage/object-store.js';
import { makeCountersignFixture, makePublisherFixture } from '../countersign/fixtures/envelope.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';

const REGISTRY_ID = 'registry.test';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const REVIEWER_SUB = 'reviewer-1';
const OPERATOR_SUB = 'operator-1';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const PASS_REPORT: AutomatedReviewReport = {
  checksModule: '@gridmason/cli/checks',
  checksVersion: '0.6.0',
  status: 'pass',
  results: [{ id: 'manifest.schema', status: 'pass', message: 'ok' }],
};

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  publisherStore: InMemoryPublisherStore;
  artifactStore: InMemoryArtifactStore;
  reviewCaseStore: InMemoryReviewCaseStore;
  objectStore: InMemoryObjectStore;
}

describe('GET /v1/widgets — widget catalog (#63)', () => {
  let issuer: FakeIssuer;
  let reviewerToken: string;
  let operatorToken: string;
  let h: Harness;
  const authors = new Set<string>();

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    reviewerToken = await issuer.sign({ iss: issuer.issuer, sub: REVIEWER_SUB, exp: FUTURE });
    operatorToken = await issuer.sign({ iss: issuer.issuer, sub: OPERATOR_SUB, exp: FUTURE });
  });
  afterAll(async () => {
    await issuer.close();
  });

  beforeEach(async () => {
    setAuditSink({ emit: () => {} });
    authors.clear();
    const config = loadConfig({
      LOG_LEVEL: 'silent',
      REGISTRY_ID,
      REVIEW_REVIEWER_IDENTITIES: composeOidcIdentity(issuer.issuer, REVIEWER_SUB),
      OPS_OPERATOR_IDENTITIES: composeOidcIdentity(issuer.issuer, OPERATOR_SUB),
    });
    const publisherStore = new InMemoryPublisherStore();
    const artifactStore = new InMemoryArtifactStore();
    const reviewCaseStore = new InMemoryReviewCaseStore();
    const objectStore = new InMemoryObjectStore();
    const app = await buildServer({
      config,
      logger: createLogger(config),
      publisherStore,
      artifactStore,
      objectStore,
      reviewCaseStore,
      releaseDocStore: new InMemoryReleaseDocStore(),
      feedEntryStore: new InMemoryFeedEntryStore(),
      countersignIdentity: loadCountersignIdentity(makeCountersignFixture())!,
      transparencyLog: new InMemoryTransparencyLog(REGISTRY_ID),
      oidcVerifier: createOidcVerifier({ issuerAllowlist: [issuer.issuer] }),
    });
    h = { app, publisherStore, artifactStore, reviewCaseStore, objectStore };
  });
  afterEach(async () => {
    setAuditSink(noopAuditSink);
    await h.app.close();
  });

  /** Seed one widget version and approve it over HTTP so countersign publishes its release. Returns the artifact id. */
  async function publishAndApprove(opts: {
    prefix: string;
    tag: string;
    version: string;
    name: string;
    capabilities?: { api: string; scope?: string }[];
  }): Promise<string> {
    const authorSub = `author-${opts.prefix}`;
    if (!authors.has(opts.prefix)) {
      await h.publisherStore.register({ issuer: issuer.issuer, subject: authorSub, prefix: opts.prefix, tier: 'operator' });
      authors.add(opts.prefix);
    }
    const author = await h.publisherStore.findByIdentity(issuer.issuer, authorSub);

    const manifestBytes = enc(
      JSON.stringify({
        formatVersion: '1.0',
        tag: opts.tag,
        kind: 'widget',
        name: opts.name,
        publisher: opts.prefix,
        version: opts.version,
        entry: 'entry.js',
        ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
      }),
    );
    const entryBytes = enc('export default class extends HTMLElement {}');
    const files: Record<string, MultihashString> = {
      'manifest.json': await hashBytes(manifestBytes),
      'entry.js': await hashBytes(entryBytes),
    };
    await h.objectStore.putObject(files['manifest.json']!, manifestBytes);
    await h.objectStore.putObject(files['entry.js']!, entryBytes);

    const pub = await makePublisherFixture({ artifactId: `${opts.tag}@${opts.version}`, files, issuer: issuer.issuer });
    const created = await h.artifactStore.create({
      publisherId: author!.id,
      tag: opts.tag,
      version: opts.version,
      contentHashes: files,
      sourceArchiveRef: null,
      envelope: pub.publisherEnvelope,
    });
    if (!created.ok) throw new Error('seed create failed');
    await h.artifactStore.transition(created.record.id, 'submitted', 'reviewing');
    const reviewCase = await h.reviewCaseStore.create({ artifactId: created.record.id, checksReport: PASS_REPORT });
    const verdict = await h.app.inject({
      method: 'POST',
      url: `/v1/review/cases/${reviewCase.id}/verdict`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: { decision: 'approve' },
    });
    if (verdict.statusCode !== 201) throw new Error(`approve failed: ${verdict.statusCode} ${verdict.payload}`);
    return created.record.id;
  }

  const list = (qs = '') => h.app.inject({ method: 'GET', url: `/v1/widgets${qs}`, headers: { origin: 'http://localhost:5173' } });

  it('lists a published+approved widget with its manifest fields (empty before)', async () => {
    expect((await list()).json()).toEqual({ widgets: [], nextCursor: null });

    await publishAndApprove({
      prefix: 'acme',
      tag: 'acme-clock',
      version: '1.0.0',
      name: 'Acme Clock',
      capabilities: [{ api: 'records.read', scope: 'recordType:example' }],
    });

    const res = await list();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nextCursor).toBeNull();
    expect(body.widgets).toHaveLength(1);
    expect(body.widgets[0]).toMatchObject({
      publisher: 'acme',
      tag: 'acme-clock',
      name: 'Acme Clock',
      description: null,
      latestVersion: '1.0.0',
      versions: ['1.0.0'],
      capabilities: [{ api: 'records.read', scope: 'recordType:example' }],
    });
    // The anonymous read carries wildcard CORS (#57 allowlist).
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('groups versions newest-first with the latest version driving name/capabilities', async () => {
    await publishAndApprove({ prefix: 'acme', tag: 'acme-clock', version: '1.0.0', name: 'Old Clock' });
    await publishAndApprove({ prefix: 'acme', tag: 'acme-clock', version: '1.2.0', name: 'New Clock' });
    await publishAndApprove({ prefix: 'acme', tag: 'acme-clock', version: '1.1.0', name: 'Mid Clock' });

    const widgets = (await list()).json().widgets;
    expect(widgets).toHaveLength(1);
    expect(widgets[0].latestVersion).toBe('1.2.0');
    expect(widgets[0].versions).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    expect(widgets[0].name).toBe('New Clock');
  });

  it('excludes a killed widget (fail closed, same predicate as resolution)', async () => {
    const id = await publishAndApprove({ prefix: 'acme', tag: 'acme-clock', version: '1.0.0', name: 'Acme Clock' });
    await publishAndApprove({ prefix: 'beta', tag: 'beta-chart', version: '2.0.0', name: 'Beta Chart' });
    expect((await list()).json().widgets).toHaveLength(2);

    const killed = await h.app.inject({
      method: 'POST',
      url: `/v1/ops/artifacts/${id}/kill`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { severity: 'critical', reason: 'exploited' },
    });
    expect(killed.statusCode).toBe(201);

    const widgets = (await list()).json().widgets;
    expect(widgets).toHaveLength(1);
    expect(widgets[0].tag).toBe('beta-chart');
  });

  it('paginates by keyset with an opaque cursor', async () => {
    await publishAndApprove({ prefix: 'acme', tag: 'acme-a', version: '1.0.0', name: 'A' });
    await publishAndApprove({ prefix: 'acme', tag: 'acme-b', version: '1.0.0', name: 'B' });
    await publishAndApprove({ prefix: 'acme', tag: 'acme-c', version: '1.0.0', name: 'C' });

    const first = (await list('?limit=2')).json();
    expect(first.widgets.map((w: { tag: string }) => w.tag)).toEqual(['acme-a', 'acme-b']);
    expect(first.nextCursor).toBeTruthy();

    const second = (await list(`?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second.widgets.map((w: { tag: string }) => w.tag)).toEqual(['acme-c']);
    expect(second.nextCursor).toBeNull();
  });

  it('filters by query substring (tag or name) and by publisher', async () => {
    await publishAndApprove({ prefix: 'acme', tag: 'acme-clock', version: '1.0.0', name: 'Timekeeper' });
    await publishAndApprove({ prefix: 'acme', tag: 'acme-chart', version: '1.0.0', name: 'Grapher' });
    await publishAndApprove({ prefix: 'beta', tag: 'beta-clock', version: '1.0.0', name: 'Beta Clock' });

    // query matches the tag substring across publishers.
    expect((await list('?query=clock')).json().widgets.map((w: { tag: string }) => w.tag)).toEqual(['acme-clock', 'beta-clock']);
    // query matches a name substring.
    expect((await list('?query=grapher')).json().widgets.map((w: { tag: string }) => w.tag)).toEqual(['acme-chart']);
    // publisher filter scopes to one prefix.
    expect((await list('?publisher=beta')).json().widgets.map((w: { tag: string }) => w.tag)).toEqual(['beta-clock']);
  });

  it('rejects a bad limit and a mangled cursor', async () => {
    expect((await list('?limit=0')).statusCode).toBe(400);
    expect((await list('?limit=abc')).statusCode).toBe(400);
    const bad = await list('?cursor=not-a-cursor');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_cursor');
  });
});
