/**
 * Full-chain e2e (FR-13; SPEC §6, §10, §11) — the Phase-B-exit proof, now driven
 * **entirely by the real `gridmason` binary** over real HTTP against a
 * **compose-launched instance**: the R-E0 compose stack's Postgres + object store
 * back a real {@link buildServer} boot, and the chain is
 *
 *   gridmason widget init → gridmason publish (real keyless sign + upload) →
 *   the registry's real automated review → human approve → real countersign →
 *   dashboard-style resolve + `@gridmason/protocol` verifyRelease → kill excludes →
 *   signed-feed authenticate + stale-past-TTL fail-closed.
 *
 * ## No more seeded legs (registry#55 / gridmason/cli#70 shipped)
 *
 * The two blockers this suite used to work around are resolved:
 *  - `@gridmason/cli@0.6.0` emits the protocol `SignatureEnvelope` and exposes an
 *    **offline** keyless signer selectable from the binary (`publish --signer
 *    ephemeral`), so CI drives the real binary deterministically — no Sigstore
 *    network; and
 *  - registry intake now accepts that protocol envelope (`src/artifact/envelope.ts`),
 *    so a real upload countersigns into a resolvable, verifiable release.
 *
 * So every leg below is real and over HTTP; nothing is pre-seeded into the store.
 *
 * ## Trust roots (no production path weakened)
 *
 * The OIDC issuer, reviewer roster, operator set, and countersign key are
 * test-provided config — what a self-host operator provides at install
 * (`docs/self-host/install.md`). `publish --signer ephemeral` mints a **self-issued**
 * keyless leaf (a dev/e2e affordance, never a Fulcio identity), so the host verify
 * pins that leaf's own public key as the publisher root **in this e2e's own trust
 * config only** — read off the resolved bundle, exactly as a host pins a root it
 * has chosen to trust. Production verify paths are untouched: a real host still
 * pins real Fulcio roots and would refuse the ephemeral leaf. The transparency log
 * is the in-process `memory` log the compose default uses (injected so the
 * host-side inclusion check can read its checkpoint key).
 */
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  evaluateFreshness,
  hashBytes,
  verifyRelease,
  verifyRevocationFeed,
  type TrustRootPin,
} from '@gridmason/protocol';

import { noopAuditSink, setAuditSink } from '../../src/audit/index.js';
import { loadConfig, type Config } from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';
import { composeOidcIdentity } from '../../src/publisher/types.js';
import { buildServer } from '../../src/server.js';
import { InMemoryTransparencyLog } from '../../src/sigstore/log.js';
import { createStorage, type Storage } from '../../src/storage/index.js';
import { makeCountersignFixture, type CountersignFixture } from '../countersign/fixtures/envelope.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';

// The published `gridmason` binary (the dependency under test), invoked as the CLI
// and a publisher would invoke it.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GRIDMASON_BIN = path.join(REPO_ROOT, 'node_modules/@gridmason/cli/dist/bin/gridmason.js');

// A distinct per-run identity/prefix so a re-run against a persistent DB is not
// blocked by unique constraints (CI runs a fresh compose DB regardless).
const RUN = Date.now().toString(36);
const REGISTRY_ID = process.env.REGISTRY_ID ?? 'registry.e2e';
const AUTHOR = `author-${RUN}`;
const REVIEWER = `reviewer-${RUN}`;
const OPERATOR = `operator-${RUN}`;
const PREFIX = `acme${RUN}`;
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

type Json = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

let issuer: FakeIssuer;
let storage: Storage;
let app: Awaited<ReturnType<typeof buildServer>>;
let log: InMemoryTransparencyLog;
let cs: CountersignFixture;
let base: string;
let tmp: string;
let projectDir: string;
let tag: string;
let version: string;
let authorTok: string;
let reviewerTok: string;
let operatorTok: string;
// Set by Part A (the published artifact), consumed by Parts B/C.
let artifactId: string;

async function http(method: string, p: string, token?: string, body?: unknown): Promise<Json> {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
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

/** Run the real `gridmason` binary; resolves with its exit code + captured streams. */
function gridmason(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GRIDMASON_BIN, ...args], { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

beforeAll(async () => {
  setAuditSink({ emit: () => {} });
  issuer = await startFakeIssuer();
  cs = makeCountersignFixture();

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
  await storage.postgres.ping(); // fail fast + clearly if the compose stack is down / unmigrated
  await storage.objectStore.ping();

  log = new InMemoryTransparencyLog(config.registryId);
  app = await buildServer({ config, logger, storage, transparencyLog: log });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  authorTok = await issuer.sign({ iss: issuer.issuer, sub: AUTHOR, email: `${AUTHOR}@acme.example`, exp: FUTURE });
  reviewerTok = await issuer.sign({ iss: issuer.issuer, sub: REVIEWER, exp: FUTURE });
  operatorTok = await issuer.sign({ iss: issuer.issuer, sub: OPERATOR, exp: FUTURE });

  // Register the publisher, then scaffold a real widget project with the binary.
  const reg = await http('POST', '/v1/publishers', authorTok, { prefix: PREFIX, tier: 'operator' });
  if (reg.status !== 201) throw new Error(`publisher registration failed: ${reg.status} ${JSON.stringify(reg.body)}`);

  tmp = await mkdtemp(path.join(tmpdir(), 'gm-fullchain-e2e-'));
  const init = await gridmason(['widget', 'init', 'clock', '--publisher', PREFIX, '--framework', 'vanilla', '--json'], tmp);
  if (init.code !== 0) throw new Error(`widget init failed: ${init.err || init.out}`);
  const initJson = JSON.parse(init.out) as { directory: string };
  projectDir = path.join(tmp, initJson.directory);
  const manifest = JSON.parse(await readFile(path.join(projectDir, 'manifest.json'), 'utf8')) as { tag: string; version: string };
  tag = manifest.tag;
  version = manifest.version;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await storage?.close();
  await issuer?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
  setAuditSink(noopAuditSink);
});

function gate() {
  return { registry: REGISTRY_ID, modules: [{ publisher: PREFIX, tag, version }], shared: {} };
}

/**
 * PART A — the real publish + review chain over HTTP: `gridmason publish --signer
 * ephemeral` (real keyless sign + upload of the protocol envelope) → the
 * registry's real automated review (the shared `@gridmason/cli/checks`) → a
 * reviewer approves over HTTP (driven concurrently, as a reviewer would while the
 * publisher waits) → the real countersign stage publishes a release.
 */
describe('Part A — real gridmason publish → automated review → human approve', () => {
  it('publishes a scaffolded widget and a reviewer approves it, driving countersign', async () => {
    // The reviewer acts while `publish` polls: as soon as automated review puts the
    // artifact on the queue, approve it, so the binary's next poll sees `approved`.
    const approving = (async () => {
      for (let i = 0; i < 200; i++) {
        const queue = await http('GET', '/v1/review/queue', reviewerTok);
        const theCase = queue.body?.cases?.find((c: { artifact: { tag: string } }) => c.artifact.tag === tag);
        if (theCase) {
          return http('POST', `/v1/review/cases/${theCase.caseId}/verdict`, reviewerTok, { decision: 'approve' });
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return null;
    })();

    const publish = await gridmason(
      ['publish', projectDir, '--registry', base, '--token', authorTok, '--signer', 'ephemeral', '--json'],
      tmp,
    );
    const approved = await approving;

    expect(approved?.status, JSON.stringify(approved?.body)).toBe(201);
    expect(approved?.body.artifactState).toBe('approved');
    expect(publish.code, publish.err || publish.out).toBe(0);
    const report = JSON.parse(publish.out.trim().split('\n').pop() ?? '{}');
    expect(report.status).toBe('published');
    expect(report.state).toBe('approved');
    artifactId = report.id;
  }, 60_000);
});

/**
 * PART B — resolve the real countersigned release and verify it end to end with
 * `@gridmason/protocol`, then prove the SPEC §6 revocation fail-closed.
 */
describe('Part B — resolve → verifyRelease → kill excludes (real release)', () => {
  it('resolves the published release into a hash-pinned fragment', async () => {
    const res = await http('POST', '/v1/resolve', undefined, gate());
    expect(res.status).toBe(200);
    expect(res.body.excluded).toEqual([]);
    expect(res.body.modules).toHaveLength(1);
    expect(res.body.imports[`${REGISTRY_ID}/${tag}`]).toBe(res.body.modules[0].url);
  });

  it('verifies the fragment URL end to end via verifyRelease + serving hash', async () => {
    const res = await http('POST', '/v1/resolve', undefined, gate());
    const mod = res.body.modules[0];

    // The ephemeral publisher leaf's own SPKI is the publisher root a host pins for
    // this dev/e2e signer — read off the bundle, scoped to this e2e's trust config
    // only (a production host pins real Fulcio roots and refuses this leaf).
    const leaf = new X509Certificate(Buffer.from(mod.bundle.envelope.publisherSig.cert, 'base64'));
    const leafSpki = new Uint8Array(leaf.publicKey.export({ type: 'spki', format: 'der' }));

    const pins: TrustRootPin[] = [{ registryId: REGISTRY_ID, root: 'cs-root', channel: 'build-time' }];
    const trustRoot = {
      formatVersion: '1.0',
      registryId: REGISTRY_ID,
      countersignRoots: ['cs-root'],
      issuerAllowlist: [issuer.issuer],
      logPublicKeys: ['log-key'],
      notBefore: 0,
      notAfter: Date.now() + 3_600_000,
    };
    const verdict = await verifyRelease({
      release: mod.bundle.release,
      envelope: mod.bundle.envelope,
      trustRoot,
      pins,
      publisherCARoots: [leafSpki],
      countersignRoots: [cs.countersignRootSpki],
      logEntry: mod.bundle.logEntry,
      logPublicKey: log.publicKey(),
      now: Date.now(),
    });
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);

    // The URL fetches the exact immutable bytes, which hash to the pinned entry hash.
    const served = await fetch(base + mod.url);
    expect(served.status).toBe(200);
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(`/v1/artifacts/${await hashBytes(bytes)}`).toBe(mod.url);
  });

  it('NEGATIVE: a killed artifact is excluded from resolution (fail closed for revocation)', async () => {
    const killed = await http('POST', `/v1/ops/artifacts/${artifactId}/kill`, operatorTok, {
      severity: 'critical',
      reason: 'actively exploited',
    });
    expect(killed.status, JSON.stringify(killed.body)).toBe(201);
    expect(killed.body.artifactState).toBe('killed');

    const res = await http('POST', '/v1/resolve', undefined, gate());
    expect(res.body.imports).toEqual({});
    expect(res.body.modules).toEqual([]);
    expect(res.body.excluded).toHaveLength(1);
    expect(res.body.excluded[0].reason).toBe('not_distributable');
  });
});

/**
 * PART C — the signed revocation feed is authenticated with `@gridmason/protocol`
 * and run through `evaluateFreshness` for both the fresh and the stale-past-TTL
 * fail-closed verdicts (SPEC §6, §10).
 */
describe('Part C — signed revocation feed: authenticate + freshness', () => {
  it('authenticates the served feed and lists the killed artifact', async () => {
    const feed = await http('GET', '/v1/revocation/feed');
    expect(feed.status).toBe(200);
    const verdict = await verifyRevocationFeed(feed.body, { countersignRoots: [cs.countersignRootSpki] });
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    expect(feed.body.feed.entries.some((e: { artifact: string; state: string }) => e.artifact === `${tag}@${version}` && e.state === 'killed')).toBe(true);
  });

  it('evaluateFreshness returns fresh within TTL and blocks the killed artifact', async () => {
    const feed = (await http('GET', '/v1/revocation/feed')).body;
    const cursor = { registryId: REGISTRY_ID, seq: -1 };
    const fresh = evaluateFreshness(feed.feed, cursor, feed.feed.issuedAt);
    expect(fresh.code).toBe('fresh');
    expect(fresh.ok).toBe(true);
    expect(fresh.blocked.some((b: { artifact: string }) => b.artifact === `${tag}@${version}`)).toBe(true);
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
