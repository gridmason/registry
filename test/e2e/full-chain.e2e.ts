/**
 * Full-chain e2e (FR-13; SPEC §6, §10, §11) — the Phase-B-exit proof, driven
 * over **real HTTP** against a **compose-launched instance**: the R-E0 compose
 * stack's Postgres + object store back a real {@link buildServer} boot, and every
 * step below is an HTTP request to it, exactly as the CLI and a host make them.
 *
 * ## What this suite covers, and why some legs are seeded
 *
 * Two cross-repo contract gaps (documented in `docs/e2e.md` + the PR) mean the
 * chain cannot yet be driven *entirely* by the real `gridmason` binary against a
 * real release:
 *
 *  - the published `gridmason` binary signs only via live Sigstore (no offline
 *    signer selectable, and the offline `runPublish` is not exported), so it
 *    cannot publish deterministically in CI; and
 *  - the CLI uploads a **DSSE** envelope while the registry countersign consumes
 *    the protocol **`SignatureEnvelope`** — nothing bridges the two, so an
 *    artifact created through real intake is approvable but never countersigned
 *    into a resolvable release.
 *
 * So the suite splits, honestly:
 *
 *  - **Compose-driven, real HTTP (Part A):** publisher register → DSSE upload →
 *    the registry's **real** automated review (the shared `@gridmason/cli/checks`
 *    the CLI runs) → `/status` poll → human approve. Then it asserts the DSSE
 *    artifact resolves to `no_release` — a live regression guard on the envelope
 *    bridge gap (this assertion flips the day the bridge lands).
 *  - **Compose-driven, real HTTP, seeded release (Part B):** an artifact carrying
 *    the protocol-shaped publisher envelope is seeded directly into the same
 *    Postgres the server reads (the only path to a countersignable envelope until
 *    the bridge lands — clearly marked), then approved over HTTP so the real
 *    countersign stage runs; the release is resolved, its bundle verified with
 *    `@gridmason/protocol` `verifyRelease`, and its entry byte-fetched from the
 *    serving origin and hash-checked. A kill then excludes it (revoked/killed
 *    fail-closed, SPEC §6).
 *  - **Compose-driven, real HTTP (Part C):** the signed revocation feed is
 *    fetched, authenticated with `verifyRevocationFeed`, and run through
 *    `evaluateFreshness` for both the fresh and the **stale-past-TTL fail-closed**
 *    verdicts (SPEC §6, §10).
 *
 * The OIDC issuer, reviewer roster, operator set, and countersign key are
 * test-provided config — exactly what a self-host operator provides at install
 * (`docs/self-host/install.md`) — and the transparency log is the in-process
 * `memory` log the compose default uses (injected so the test can read its
 * checkpoint key for the host-side inclusion check).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  evaluateFreshness,
  hashBytes,
  verifyRelease,
  verifyRevocationFeed,
  type MultihashString,
  type TrustRootPin,
} from '@gridmason/protocol';

import { createPostgresArtifactStore } from '../../src/artifact/store.js';
import { noopAuditSink, setAuditSink } from '../../src/audit/index.js';
import { loadConfig, type Config } from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';
import { createPostgresPublisherStore } from '../../src/publisher/store.js';
import { composeOidcIdentity } from '../../src/publisher/types.js';
import type { AutomatedReviewReport } from '../../src/review/report.js';
import { createPostgresReviewCaseStore } from '../../src/review/store.js';
import { buildServer } from '../../src/server.js';
import { InMemoryTransparencyLog } from '../../src/sigstore/log.js';
import { createStorage, type Storage } from '../../src/storage/index.js';
import {
  makeCountersignFixture,
  makePublisherFixture,
  type CountersignFixture,
} from '../countersign/fixtures/envelope.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';

// Distinct per-run identities/prefixes so a re-run against a persistent DB is not
// blocked by unique constraints (CI runs a fresh compose DB regardless).
const RUN = Date.now().toString(36);
const REGISTRY_ID = process.env.REGISTRY_ID ?? 'registry.e2e';
const AUTHOR_HTTP = `author-http-${RUN}`;
const AUTHOR_SEED = `author-seed-${RUN}`;
const REVIEWER = `reviewer-${RUN}`;
const OPERATOR = `operator-${RUN}`;
const PREFIX_HTTP = `acmehttp${RUN}`;
const PREFIX_SEED = `acmeseed${RUN}`;
const TAG_HTTP = `${PREFIX_HTTP}-clock`;
const TAG_SEED = `${PREFIX_SEED}-clock`;
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

const b64 = (s: string): string => Buffer.from(s).toString('base64');
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// The response bodies are the registry's typed JSON surfaces; this suite reads
// their fields directly (as the CLI and a host do), so the body is intentionally
// loose here rather than re-declaring every wire shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = { status: number; body: any };

let issuer: FakeIssuer;
let storage: Storage;
let app: Awaited<ReturnType<typeof buildServer>>;
let log: InMemoryTransparencyLog;
let cs: CountersignFixture;
let base: string;
let authorHttpTok: string;
let reviewerTok: string;
let operatorTok: string;

async function http(method: string, path: string, token?: string, body?: unknown): Promise<Json> {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  setAuditSink({ emit: () => {} });
  issuer = await startFakeIssuer();
  cs = makeCountersignFixture();

  // Config: compose backing stores (DATABASE_URL / OBJECT_STORE_* default to the
  // compose published ports — see compose.yaml) + test-provided identity/roster/
  // key, exactly as a self-host operator provides them at install.
  const config: Config = loadConfig({
    ...process.env,
    LOG_LEVEL: 'silent',
    REGISTRY_ID,
    OIDC_ISSUER_ALLOWLIST: issuer.issuer,
    REVIEW_REVIEWER_IDENTITIES: composeOidcIdentity(issuer.issuer, REVIEWER),
    OPS_OPERATOR_IDENTITIES: composeOidcIdentity(issuer.issuer, OPERATOR),
    COUNTERSIGN_PRIVATE_KEY: cs.privateKeyPem,
    COUNTERSIGN_CERTIFICATE: cs.certificatePem,
  });
  const logger = createLogger(config);

  storage = createStorage(config);
  // Fail fast with a clear message if the compose stack is not up / not migrated.
  await storage.postgres.ping();
  await storage.objectStore.ping();

  // Inject the in-process memory log (the compose default) so the test can read
  // its checkpoint key for the host-side log-inclusion check; everything else is
  // the real config-driven boot over the compose-backed storage.
  log = new InMemoryTransparencyLog(config.registryId);
  app = await buildServer({ config, logger, storage, transparencyLog: log });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  authorHttpTok = await issuer.sign({ iss: issuer.issuer, sub: AUTHOR_HTTP, exp: FUTURE });
  reviewerTok = await issuer.sign({ iss: issuer.issuer, sub: REVIEWER, exp: FUTURE });
  operatorTok = await issuer.sign({ iss: issuer.issuer, sub: OPERATOR, exp: FUTURE });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await storage?.close();
  await issuer?.close();
  setAuditSink(noopAuditSink);
});

/**
 * PART A — real HTTP against compose: register → DSSE upload → the registry's
 * real automated review (shared `@gridmason/cli/checks`) → `/status` poll →
 * human approve. This is the whole publish + review + status contract the CLI
 * drives, exercised end to end over a socket against the compose instance.
 */
describe('Part A — CLI-shaped publish + automated review + human approve (real HTTP)', () => {
  let artifactId: string;

  it('registers a publisher and its prefix', async () => {
    const reg = await http('POST', '/v1/publishers', authorHttpTok, { prefix: PREFIX_HTTP, tier: 'operator' });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    expect(reg.body.prefix).toBe(PREFIX_HTTP);
  });

  it('uploads a DSSE-signed artifact; the real automated review advances it to reviewing', async () => {
    // A manifest that passes the shared checks locally passes the registry's
    // automated review by construction (FR-3 — one implementation, no divergence).
    const manifest = {
      formatVersion: '1.0',
      tag: TAG_HTTP,
      kind: 'widget',
      name: 'E2E Clock',
      publisher: PREFIX_HTTP,
      version: '1.0.0',
      entry: 'entry.js',
    };
    // The DSSE envelope shape the CLI signs + uploads (`payloadType`/`payload`/
    // `signatures[]`); intake validates it structurally only.
    const envelope = {
      payloadType: 'application/vnd.gridmason.artifact+json',
      payload: b64('{"tag":"' + TAG_HTTP + '"}'),
      signatures: [{ sig: b64('dsse-signature'), keyid: 'oidc' }],
    };
    const up = await http('POST', '/v1/artifacts', authorHttpTok, {
      tag: TAG_HTTP,
      version: '1.0.0',
      files: [
        { path: 'manifest.json', role: 'manifest', bytes: b64(JSON.stringify(manifest)) },
        { path: 'entry.js', role: 'entry', bytes: b64('export default class extends HTMLElement {}') },
      ],
      sourceArchive: b64('source-archive'),
      envelope,
    });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.state).toBe('reviewing');
    artifactId = up.body.id;
  });

  it('polls review status at /v1/artifacts/:id/status (the CLI contract path)', async () => {
    const status = await http('GET', `/v1/artifacts/${encodeURIComponent(artifactId)}/status`, authorHttpTok);
    expect(status.status).toBe(200);
    expect(status.body.state).toBe('reviewing');
  });

  it('a reviewer takes the case from the queue and approves it', async () => {
    const queue = await http('GET', '/v1/review/queue', reviewerTok);
    expect(queue.status).toBe(200);
    const theCase = queue.body.cases.find((c: { artifact: { id: string } }) => c.artifact.id === artifactId);
    expect(theCase, 'artifact should be in the review queue').toBeTruthy();
    const verdict = await http('POST', `/v1/review/cases/${theCase.caseId}/verdict`, reviewerTok, { decision: 'approve' });
    expect(verdict.status, JSON.stringify(verdict.body)).toBe(201);
    expect(verdict.body.artifactState).toBe('approved');
  });

  it('DOCUMENTED GAP: the DSSE-signed artifact resolves to no_release (envelope bridge unbuilt)', async () => {
    // The countersign stage cannot consume the CLI's DSSE envelope, so an
    // approved DSSE artifact has no release doc and is excluded as `no_release`.
    // When the DSSE→SignatureEnvelope bridge lands, this assertion FAILS — a
    // deliberate reminder to re-point Part A at a real countersigned release.
    const res = await http('POST', '/v1/resolve', undefined, {
      registry: REGISTRY_ID,
      modules: [{ publisher: PREFIX_HTTP, tag: TAG_HTTP, version: '1.0.0' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.imports).toEqual({});
    expect(res.body.excluded).toHaveLength(1);
    expect(res.body.excluded[0].reason).toBe('no_release');
  });
});

/**
 * PART B — real HTTP against compose, SEEDED release. Until the envelope bridge
 * lands, a countersignable publisher envelope can only be introduced by seeding
 * the protocol-shaped envelope directly into the same Postgres the server reads
 * (bypassing the DSSE-only intake). Everything after the seed is real: the human
 * approve, the countersign stage, serving, resolution, verification, and the kill
 * are all driven over HTTP against the compose instance.
 */
describe('Part B — countersign → resolve → verify → kill (real HTTP, SEEDED envelope pending the bridge)', () => {
  let seededArtifactId: string;
  let publisher: Awaited<ReturnType<typeof makePublisherFixture>>;
  let entryHash: MultihashString;

  const gate = () => ({
    registry: REGISTRY_ID,
    modules: [{ publisher: PREFIX_SEED, tag: TAG_SEED, version: '2.0.0' }],
    shared: {
      react: [
        { major: 18, url: '/vendor/react@18.js' },
        { major: 17, url: '/vendor/react@17.js' },
      ],
    },
  });

  it('seeds an approvable artifact carrying the protocol publisher envelope, then approves it over HTTP', async () => {
    const logger = createLogger(loadConfig({ ...process.env, LOG_LEVEL: 'silent', REGISTRY_ID }));
    const publisherStore = createPostgresPublisherStore(storage.postgres, logger);
    const artifactStore = createPostgresArtifactStore(storage.postgres, logger);
    const reviewCaseStore = createPostgresReviewCaseStore(storage.postgres);

    const reg = await publisherStore.register({ issuer: issuer.issuer, subject: AUTHOR_SEED, prefix: PREFIX_SEED, tier: 'operator' });
    expect(reg.ok, JSON.stringify(reg)).toBe(true);
    const author = await publisherStore.findByIdentity(issuer.issuer, AUTHOR_SEED);

    // Real bytes → real content hashes; the manifest names its entry + a
    // sharedScope the shell must satisfy, and both blobs go into the object store.
    const manifestBytes = enc(JSON.stringify({ formatVersion: '1.0', tag: TAG_SEED, entry: 'entry.js', sharedScope: { react: '^17.0.0' } }));
    const entryBytes = enc('export default class extends HTMLElement {}');
    const files: Record<string, MultihashString> = {
      'manifest.json': await hashBytes(manifestBytes),
      'entry.js': await hashBytes(entryBytes),
    };
    entryHash = files['entry.js']!;
    await storage.objectStore.putObject(files['manifest.json']!, manifestBytes);
    await storage.objectStore.putObject(files['entry.js']!, entryBytes);

    publisher = await makePublisherFixture({ artifactId: `${TAG_SEED}@2.0.0`, files, issuer: issuer.issuer });
    const created = await artifactStore.create({
      publisherId: author!.id,
      tag: TAG_SEED,
      version: '2.0.0',
      contentHashes: files,
      sourceArchiveRef: null,
      envelope: publisher.publisherEnvelope,
    });
    expect(created.ok, 'seed create').toBe(true);
    if (!created.ok) return;
    seededArtifactId = created.record.id;
    await artifactStore.transition(seededArtifactId, 'submitted', 'reviewing');
    const report: AutomatedReviewReport = {
      checksModule: '@gridmason/cli/checks',
      checksVersion: '0.0.3',
      status: 'pass',
      results: [{ id: 'manifest.schema', status: 'pass', message: 'ok' }],
    };
    const reviewCase = await reviewCaseStore.create({ artifactId: seededArtifactId, checksReport: report });

    // Real HTTP approval → fires the real countersign stage against the compose instance.
    const verdict = await http('POST', `/v1/review/cases/${reviewCase.id}/verdict`, reviewerTok, { decision: 'approve' });
    expect(verdict.status, JSON.stringify(verdict.body)).toBe(201);
    expect(verdict.body.artifactState).toBe('approved');
  });

  it('resolves the countersigned release into a hash-pinned fragment with a scope entry', async () => {
    const res = await http('POST', '/v1/resolve', undefined, gate());
    expect(res.status).toBe(200);
    expect(res.body.excluded).toEqual([]);
    expect(res.body.modules).toHaveLength(1);
    expect(res.body.imports[`${REGISTRY_ID}/${TAG_SEED}`]).toBe(`/v1/artifacts/${entryHash}`);
    // The widget needs react ^17 while the shell default is 18 → a scoped override.
    expect(res.body.scopes[`/v1/artifacts/${entryHash}`]).toEqual({ react: '/vendor/react@17.js' });
  });

  it('verifies each fragment URL end to end via @gridmason/protocol verifyRelease + serving hash', async () => {
    const res = await http('POST', '/v1/resolve', undefined, gate());
    const mod = res.body.modules[0];

    const pins: TrustRootPin[] = [{ registryId: REGISTRY_ID, root: 'cs-root', channel: 'build-time' }];
    const trustRoot = {
      formatVersion: '1.0',
      registryId: REGISTRY_ID,
      countersignRoots: ['cs-root'],
      issuerAllowlist: [publisher.issuer],
      logPublicKeys: ['log-key'],
      notBefore: 0,
      notAfter: Date.now() + 3_600_000,
    };
    const verdict = await verifyRelease({
      release: mod.bundle.release,
      envelope: mod.bundle.envelope,
      trustRoot,
      pins,
      publisherCARoots: [publisher.publisherCASpki],
      countersignRoots: [cs.countersignRootSpki],
      logEntry: mod.bundle.logEntry,
      logPublicKey: log.publicKey(),
      now: Date.now(),
    });
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);

    // The URL fetches the exact immutable bytes from the serving origin, and they
    // hash to the entry hash the verified release pins (end-to-end URL trust).
    const served = await fetch(base + mod.url);
    expect(served.status).toBe(200);
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(await hashBytes(bytes)).toBe(entryHash);
  });

  it('NEGATIVE: a killed artifact is excluded from resolution (fail closed for revocation)', async () => {
    const killed = await http('POST', `/v1/ops/artifacts/${seededArtifactId}/kill`, operatorTok, {
      severity: 'critical',
      reason: 'actively exploited',
    });
    expect(killed.status, JSON.stringify(killed.body)).toBe(201);
    expect(killed.body.artifactState).toBe('killed');

    const res = await http('POST', '/v1/resolve', undefined, gate());
    expect(res.status).toBe(200);
    expect(res.body.imports).toEqual({});
    expect(res.body.modules).toEqual([]);
    expect(res.body.excluded).toHaveLength(1);
    expect(res.body.excluded[0].reason).toBe('not_distributable');
  });
});

/**
 * PART C — real HTTP against compose: the signed revocation feed is authenticated
 * with `@gridmason/protocol` and run through `evaluateFreshness` for both the
 * fresh verdict (blocking the killed artifact) and the stale-past-TTL fail-closed
 * verdict (SPEC §6, §10). No seeding — the feed is served live by the instance.
 */
describe('Part C — signed revocation feed: authenticate + freshness (real HTTP)', () => {
  it('authenticates the served feed and lists the killed artifact', async () => {
    const feed = await http('GET', '/v1/revocation/feed');
    expect(feed.status).toBe(200);
    const verdict = await verifyRevocationFeed(feed.body, { countersignRoots: [cs.countersignRootSpki] });
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    expect(feed.body.feed.entries.some((e: { artifact: string; state: string }) => e.artifact === `${TAG_SEED}@2.0.0` && e.state === 'killed')).toBe(true);
  });

  it('evaluateFreshness returns fresh within TTL and blocks the killed artifact', async () => {
    const feed = (await http('GET', '/v1/revocation/feed')).body;
    const cursor = { registryId: REGISTRY_ID, seq: -1 };
    const fresh = evaluateFreshness(feed.feed, cursor, feed.feed.issuedAt);
    expect(fresh.code).toBe('fresh');
    expect(fresh.ok).toBe(true);
    expect(fresh.blocked.some((b: { artifact: string }) => b.artifact === `${TAG_SEED}@2.0.0`)).toBe(true);
  });

  it('NEGATIVE: a feed past its TTL fails closed (stale)', async () => {
    const feed = (await http('GET', '/v1/revocation/feed')).body;
    const cursor = { registryId: REGISTRY_ID, seq: -1 };
    const staleNow = feed.feed.issuedAt + feed.feed.ttlSeconds * 1000 + 1000;
    const stale = evaluateFreshness(feed.feed, cursor, staleNow);
    expect(stale.code).toBe('stale');
    expect(stale.ok).toBe(false);
  });
});
