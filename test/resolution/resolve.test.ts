/**
 * Gate-snapshot resolver (#13, FR-7/FR-10). Unit-level over in-memory stores: the
 * fragment shape, hash-pinned entry URLs, source-qualified identity + registry id,
 * the shared-dependency `scopes` rule (a scope only for a non-default major), and
 * every exclusion path (unknown publisher/module, non-approved/revoked/killed
 * state, no release, unresolvable manifest, unsatisfied shared scope). The
 * cryptographic "every URL verifies via @gridmason/protocol" acceptance lives in
 * `api.int.test.ts` over a real countersigned release.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  ReleaseHashMap,
  SignatureEnvelope,
  TransparencyLogEntry,
} from '@gridmason/protocol';

import { InMemoryArtifactStore } from '../../src/artifact/store.js';
import type { ArtifactState } from '../../src/artifact/types.js';
import { InMemoryPublisherStore } from '../../src/publisher/store.js';
import { InMemoryReleaseDocStore } from '../../src/release/store.js';
import { resolveGateSnapshot, type ResolveDeps } from '../../src/resolution/index.js';
import type { GateSnapshot } from '../../src/resolution/index.js';
import { RELEASE_DOC_FORMAT_VERSION } from '../../src/release/release-doc.js';
import { InMemoryObjectStore } from '../../src/storage/object-store.js';

const REGISTRY_ID = 'registry.test';
const ISSUER = 'https://accounts.example.com';

/** A minimal, structurally-valid envelope — the resolver passes it through untouched. */
function stubEnvelope(artifact: string): SignatureEnvelope {
  return {
    formatVersion: '1.0',
    subject: { artifact, releaseHash: `sha2-256:${'ab'.repeat(32)}` },
    publisherSig: {
      alg: 'ES256',
      cert: 'AA==',
      issuer: ISSUER,
      subjectClaims: { email: 'dev@acme.example' },
      sig: 'AA==',
    },
    registrySig: { alg: 'ES256', cert: 'AA==', sig: 'AA==' },
    logInclusion: { logId: 'log', index: 0, proof: [] },
  };
}

/** A minimal, structurally-valid transparency-log entry (passed through to the bundle). */
function stubLogEntry(): TransparencyLogEntry {
  return {
    logId: '0'.repeat(64),
    index: 0,
    integratedTime: 0,
    canonicalBody: 'AA==',
    inclusionProof: { treeSize: 1, rootHash: '0'.repeat(64), hashes: [] },
    checkpoint: 'origin\n1\nAAAA\n',
  };
}

interface Stores {
  publisherStore: InMemoryPublisherStore;
  artifactStore: InMemoryArtifactStore;
  releaseDocStore: InMemoryReleaseDocStore;
  objectStore: InMemoryObjectStore;
}

function makeStores(): Stores {
  return {
    publisherStore: new InMemoryPublisherStore(),
    artifactStore: new InMemoryArtifactStore(),
    releaseDocStore: new InMemoryReleaseDocStore(),
    objectStore: new InMemoryObjectStore(),
  };
}

function deps(stores: Stores): ResolveDeps {
  return { ...stores, registryId: REGISTRY_ID };
}

interface SeedOptions {
  prefix?: string;
  tag?: string;
  version?: string;
  /** Final artifact state (default `approved`). */
  state?: ArtifactState;
  sharedScope?: Record<string, string>;
  /** Emit a countersigned release document (default true). */
  withRelease?: boolean;
  /** Put the manifest blob in the object store (default true). */
  withManifestBlob?: boolean;
  /** Override the manifest's `entry` path (default `entry.js`). */
  entryPath?: string;
}

/** Seed a fully-published widget and return the hash its entry serves from. */
async function seedWidget(stores: Stores, options: SeedOptions = {}): Promise<string> {
  const prefix = options.prefix ?? 'acme';
  const tag = options.tag ?? `${prefix}-clock`;
  const version = options.version ?? '1.2.0';
  const entryPath = options.entryPath ?? 'entry.js';
  const manifestHash = `sha2-256:${'11'.repeat(32)}-${tag}@${version}`;
  const entryHash = `sha2-256:${'22'.repeat(32)}-${tag}@${version}`;

  const reg = await stores.publisherStore.register({
    issuer: ISSUER,
    subject: `sub-${prefix}`,
    prefix,
    tier: 'operator',
  });
  const publisherId = reg.ok ? reg.record.id : (await stores.publisherStore.findByPrefix(prefix))!.id;

  const created = await stores.artifactStore.create({
    publisherId,
    tag,
    version,
    contentHashes: { 'manifest.json': manifestHash, [entryPath]: entryHash } as ReleaseHashMap,
    sourceArchiveRef: null,
    envelope: {},
  });
  if (!created.ok) throw new Error('seed: artifact create failed');
  const state = options.state ?? 'approved';
  if (state !== 'submitted') {
    await stores.artifactStore.transition(created.record.id, 'submitted', state);
  }

  if (options.withManifestBlob ?? true) {
    const manifest: Record<string, unknown> = { formatVersion: '1.0', tag, entry: entryPath };
    if (options.sharedScope) manifest.sharedScope = options.sharedScope;
    await stores.objectStore.putObject(
      manifestHash,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
  }

  if (options.withRelease ?? true) {
    const artifactId = `${tag}@${version}`;
    await stores.releaseDocStore.create({
      artifactId: created.record.id,
      releaseDoc: {
        formatVersion: RELEASE_DOC_FORMAT_VERSION,
        artifact: artifactId,
        files: { 'manifest.json': manifestHash, [entryPath]: entryHash } as ReleaseHashMap,
      },
      envelope: stubEnvelope(artifactId),
      logRef: 'log:0',
      logEntry: stubLogEntry(),
      waiverFlagged: false,
    });
  }

  return entryHash;
}

function snapshot(modules: GateSnapshot['modules'], shared?: GateSnapshot['shared']): GateSnapshot {
  return { registry: REGISTRY_ID, modules, shared };
}

describe('resolveGateSnapshot', () => {
  let stores: Stores;
  beforeEach(() => {
    stores = makeStores();
  });

  it('resolves an approved module to a hash-pinned, source-qualified entry', async () => {
    const entryHash = await seedWidget(stores, { tag: 'acme-clock', version: '1.2.0' });

    const fragment = await resolveGateSnapshot(
      snapshot([{ publisher: 'acme', tag: 'acme-clock', version: '1.2.0' }]),
      deps(stores),
    );

    // Registry id qualifies the whole fragment and every module (FR-10, SPEC §9).
    expect(fragment.registry).toBe(REGISTRY_ID);
    expect(fragment.excluded).toEqual([]);
    expect(fragment.modules).toHaveLength(1);

    const module = fragment.modules[0]!;
    expect(module.source).toBe(REGISTRY_ID);
    expect(module.specifier).toBe(`${REGISTRY_ID}/acme-clock`);
    // Hash-pinned URL points at the R-E2 serving origin for the entry hash (#12).
    expect(module.url).toBe(`/v1/artifacts/${entryHash}`);
    expect(fragment.imports[`${REGISTRY_ID}/acme-clock`]).toBe(`/v1/artifacts/${entryHash}`);
    // The signature bundle carries the release, envelope, and log entry a host verifies.
    expect(module.bundle.release.artifact).toBe('acme-clock@1.2.0');
    expect(module.bundle.envelope.registrySig).toBeDefined();
    expect(module.bundle.logEntry.logId).toHaveLength(64);
  });

  it('emits a scope only for a widget that needs a non-default shared major', async () => {
    // Two widgets share `react`: A takes the shell's default major (18), B needs 17.
    const aEntry = await seedWidget(stores, {
      tag: 'acme-a',
      version: '1.0.0',
      sharedScope: { react: '^18.0.0' },
    });
    const bEntry = await seedWidget(stores, {
      tag: 'acme-b',
      version: '1.0.0',
      sharedScope: { react: '^17.0.0' },
    });

    const fragment = await resolveGateSnapshot(
      snapshot(
        [
          { publisher: 'acme', tag: 'acme-a', version: '1.0.0' },
          { publisher: 'acme', tag: 'acme-b', version: '1.0.0' },
        ],
        {
          react: [
            { major: 18, url: '/vendor/react@18.js' },
            { major: 17, url: '/vendor/react@17.js' },
          ],
        },
      ),
      deps(stores),
    );

    expect(fragment.modules).toHaveLength(2);
    // A rides the default major (18) → no scope. B needs 17 → a scope keyed by its
    // entry URL, mapping react to the shell's 17 URL (GW-D22 "never globals").
    expect(fragment.scopes[`/v1/artifacts/${aEntry}`]).toBeUndefined();
    expect(fragment.scopes[`/v1/artifacts/${bEntry}`]).toEqual({ react: '/vendor/react@17.js' });
  });

  it('excludes a widget whose shared-scope range no offer satisfies', async () => {
    await seedWidget(stores, { tag: 'acme-a', version: '1.0.0', sharedScope: { react: '^16.0.0' } });

    const fragment = await resolveGateSnapshot(
      snapshot([{ publisher: 'acme', tag: 'acme-a', version: '1.0.0' }], {
        react: [{ major: 18, url: '/vendor/react@18.js' }],
      }),
      deps(stores),
    );

    expect(fragment.modules).toEqual([]);
    expect(fragment.imports).toEqual({});
    expect(fragment.excluded).toEqual([
      { publisher: 'acme', tag: 'acme-a', version: '1.0.0', reason: 'unsatisfied_shared_scope' },
    ]);
  });

  it.each([
    ['revoked' as ArtifactState],
    ['killed' as ArtifactState],
    ['reviewing' as ArtifactState],
    ['rejected' as ArtifactState],
  ])('never places a %s artifact in a fragment (SPEC §6)', async (state) => {
    await seedWidget(stores, { tag: 'acme-clock', version: '1.2.0', state });

    const fragment = await resolveGateSnapshot(
      snapshot([{ publisher: 'acme', tag: 'acme-clock', version: '1.2.0' }]),
      deps(stores),
    );

    expect(fragment.imports).toEqual({});
    expect(fragment.modules).toEqual([]);
    expect(fragment.excluded[0]?.reason).toBe('not_distributable');
  });

  it('excludes via the #14 revocation-feed seam even when the state is approved', async () => {
    await seedWidget(stores, { tag: 'acme-clock', version: '1.2.0' });

    const fragment = await resolveGateSnapshot(
      snapshot([{ publisher: 'acme', tag: 'acme-clock', version: '1.2.0' }]),
      { ...deps(stores), revocationCheck: { isRevoked: () => Promise.resolve(true) } },
    );

    expect(fragment.modules).toEqual([]);
    expect(fragment.excluded[0]?.reason).toBe('not_distributable');
  });

  it('reports unknown publisher and unknown module distinctly', async () => {
    await seedWidget(stores, { prefix: 'acme', tag: 'acme-clock', version: '1.2.0' });

    const fragment = await resolveGateSnapshot(
      snapshot([
        { publisher: 'nobody', tag: 'nobody-x', version: '1.0.0' },
        { publisher: 'acme', tag: 'acme-clock', version: '9.9.9' },
      ]),
      deps(stores),
    );

    expect(fragment.modules).toEqual([]);
    expect(fragment.excluded).toEqual([
      { publisher: 'nobody', tag: 'nobody-x', version: '1.0.0', reason: 'unknown_publisher' },
      { publisher: 'acme', tag: 'acme-clock', version: '9.9.9', reason: 'unknown_module' },
    ]);
  });

  it('excludes an approved artifact with no countersigned release', async () => {
    await seedWidget(stores, { tag: 'acme-clock', version: '1.2.0', withRelease: false });

    const fragment = await resolveGateSnapshot(
      snapshot([{ publisher: 'acme', tag: 'acme-clock', version: '1.2.0' }]),
      deps(stores),
    );

    expect(fragment.excluded[0]?.reason).toBe('no_release');
  });

  it('excludes when the manifest blob is missing from the store', async () => {
    await seedWidget(stores, { tag: 'acme-clock', version: '1.2.0', withManifestBlob: false });

    const fragment = await resolveGateSnapshot(
      snapshot([{ publisher: 'acme', tag: 'acme-clock', version: '1.2.0' }]),
      deps(stores),
    );

    expect(fragment.excluded[0]?.reason).toBe('unresolvable_release');
  });

  it('excludes when the manifest entry path is absent from the release file map', async () => {
    // The manifest names an entry the signed release does not list — inconsistent.
    await seedWidget(stores, { tag: 'acme-clock', version: '1.2.0', entryPath: 'nowhere.js' });
    // Rewrite the release so its files map lacks `nowhere.js` (only manifest.json).
    const artifact = (await stores.artifactStore.listByState('approved'))[0]!;
    const release = await stores.releaseDocStore.findByArtifact(artifact.id);
    (release!.releaseDoc.files as Record<string, string>) = {
      'manifest.json': release!.releaseDoc.files['manifest.json']!,
    };

    const fragment = await resolveGateSnapshot(
      snapshot([{ publisher: 'acme', tag: 'acme-clock', version: '1.2.0' }]),
      deps(stores),
    );

    expect(fragment.excluded[0]?.reason).toBe('unresolvable_release');
  });

  it('returns an empty fragment for an empty gate snapshot', async () => {
    const fragment = await resolveGateSnapshot(snapshot([]), deps(stores));
    expect(fragment).toEqual({
      registry: REGISTRY_ID,
      imports: {},
      scopes: {},
      modules: [],
      excluded: [],
    });
  });
});
