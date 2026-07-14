/**
 * Gate-snapshot → import-map-fragment resolution (FR-7, FR-10; SPEC §8, §9).
 *
 * The core of the Resolution API: it takes a host's {@link GateSnapshot} and the
 * distribution stores and produces the {@link ImportMapFragment} the shell merges
 * into its native-ESM import map (GW-D22). Each enabled module resolves to a
 * hash-pinned entry URL on the R-E2 serving origin plus the {@link SignatureBundle}
 * the host verifies with `@gridmason/protocol` before loading; shared-dependency
 * majors resolve to `scopes` entries (`./shared-scope`).
 *
 * **Only countersigned, approved, non-revoked artifacts resolve.** A module
 * resolves only when its `(publisher, tag, version)` names an artifact currently in
 * the `approved` state *and* backed by a countersigned release document — the same
 * release the serving surface (#12) serves. Any other state (`revoked`, `killed`,
 * `submitted`, `reviewing`, `rejected`) excludes it, so **a revoked or killed
 * remote never enters a fragment** (SPEC §6). Unresolvable modules are *reported*
 * in {@link ImportMapFragment.excluded} (so the host can render its §6/§8 fallback)
 * but never placed in `imports`.
 *
 * Pure over its injected stores — it fetches nothing itself beyond the manifest
 * blob it must read to learn a module's entry path and `sharedScope`, and holds no
 * key. Anonymous by construction: it takes no caller identity.
 */
import type { ArtifactRecord } from '../artifact/types.js';
import type { ArtifactStore } from '../artifact/store.js';
import type { PublisherStore } from '../publisher/store.js';
import type { ReleaseDocStore } from '../release/store.js';
import type { ObjectStore } from '../storage/object-store.js';
import { defaultOffer, pickOffer } from './shared-scope.js';
import type {
  ExcludedModule,
  ExclusionReason,
  GateModule,
  GateSnapshot,
  ImportMapFragment,
  ResolutionManifest,
  ResolvedModule,
  SignatureBundle,
} from './types.js';

/**
 * The served path the widget manifest lives at (the `gridmason` CLI's
 * `MANIFEST_FILE`, `gridmason/cli` src/dev/project.ts). Resolution reads the
 * manifest to learn a module's `entry` path and `sharedScope`; both are authored
 * in the manifest, and the registry does not separately persist them. A release
 * that lists no `manifest.json` cannot be resolved into a fragment.
 */
export const MANIFEST_PATH = 'manifest.json';

/**
 * The minimal structural logger the resolver writes origin faults to — satisfied
 * by both the app's pino `Logger` and Fastify's per-request `request.log`, so the
 * route passes its correlation-bound child logger without a type coupling.
 */
export interface ResolutionLogger {
  error(obj: object, msg?: string): void;
}

/** The only artifact state a fragment may load from (SPEC §3, §6). */
const DISTRIBUTABLE_STATE = 'approved';

/**
 * A cross-check against the signed revocation/kill feed (#14). The artifact
 * lifecycle `state` is the primary distribution gate here; this seam lets the
 * feed's `FeedEntry` state exclude a release that was revoked/killed out-of-band
 * between the state write and feed publication. Absent (this cut, until #14 lands)
 * resolution relies on `state` alone — see the TODO in {@link resolveGateSnapshot};
 * the audit-completeness pass (#15/#38) wires the real feed check.
 */
export interface RevocationCheck {
  /** True when the release for this artifact has been revoked or killed via the feed. */
  isRevoked(input: {
    readonly artifactId: string;
    readonly tag: string;
    readonly publisher: string;
  }): Promise<boolean>;
}

export interface ResolveDeps {
  readonly publisherStore: PublisherStore;
  readonly artifactStore: ArtifactStore;
  readonly releaseDocStore: ReleaseDocStore;
  readonly objectStore: ObjectStore;
  /** This registry's source-qualified id (SPEC §9) — stamped on every output. */
  readonly registryId: string;
  /** Optional signed-feed revocation cross-check (#14 seam). */
  readonly revocationCheck?: RevocationCheck;
  readonly logger?: ResolutionLogger;
}

/** The hash-pinned, root-relative serving URL for a content hash (#12, SPEC §10). */
function servingUrlForHash(hash: string): string {
  return `/v1/artifacts/${hash}`;
}

function excludedFrom(module: GateModule, reason: ExclusionReason): ExcludedModule {
  return {
    publisher: module.publisher,
    tag: module.tag,
    version: module.version,
    reason,
  };
}

/**
 * Read + narrow the manifest for a release. Returns the `entry` path and
 * `sharedScope`, or `null` when the manifest is missing, absent from the store, or
 * not the expected shape — every one an unresolvable release, not a crash.
 */
async function loadManifest(
  files: Readonly<Record<string, string>>,
  objectStore: ObjectStore,
  logger?: ResolutionLogger,
): Promise<ResolutionManifest | null> {
  const manifestHash = files[MANIFEST_PATH];
  if (manifestHash === undefined) return null;

  const bytes = await objectStore.getObject(manifestHash);
  if (bytes === null) {
    // A released manifest hash whose blob is absent is an origin fault: the signed
    // release lists bytes the object store should hold.
    logger?.error({ manifestHash }, 'resolution: manifest blob missing for a released hash');
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    logger?.error({ manifestHash }, 'resolution: manifest is not valid JSON');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.entry !== 'string' || manifest.entry === '') return null;

  const sharedScope =
    typeof manifest.sharedScope === 'object' && manifest.sharedScope !== null
      ? (manifest.sharedScope as Record<string, string>)
      : undefined;
  return { entry: manifest.entry, sharedScope };
}

/**
 * A module resolved far enough to know its entry URL and shared-scope needs,
 * carried between the per-module resolve pass and the scope-assembly pass.
 */
interface Resolving {
  readonly module: ResolvedModule;
  readonly sharedScope: Readonly<Record<string, string>>;
}

/**
 * Resolve one gate-snapshot module to a {@link Resolving}, or an
 * {@link ExclusionReason} when it cannot enter the fragment.
 */
async function resolveModule(
  module: GateModule,
  deps: ResolveDeps,
): Promise<Resolving | ExclusionReason> {
  const { publisherStore, artifactStore, releaseDocStore, objectStore, registryId, logger } = deps;

  const publisher = await publisherStore.findByPrefix(module.publisher);
  if (publisher === null) return 'unknown_publisher';

  const artifact: ArtifactRecord | null = await artifactStore.findByVersion(
    publisher.id,
    module.tag,
    module.version,
  );
  if (artifact === null) return 'unknown_module';

  // Distribution gate: only an approved artifact is loadable, so a revoked, killed,
  // rejected, or still-in-review artifact never enters a fragment (SPEC §6).
  if (artifact.state !== DISTRIBUTABLE_STATE) return 'not_distributable';

  // #14 seam: cross-check the signed revocation/kill feed once it lands. Until then
  // the `state` gate above is the exclusion (a kill flips the artifact to `killed`).
  if (deps.revocationCheck) {
    const revoked = await deps.revocationCheck.isRevoked({
      artifactId: artifact.id,
      tag: module.tag,
      publisher: module.publisher,
    });
    if (revoked) return 'not_distributable';
  }

  const release = await releaseDocStore.findByArtifact(artifact.id);
  if (release === null) return 'no_release';
  if (release.logEntry === null) {
    // An approved artifact whose release row carries no log entry cannot be
    // verified by a host; treat it as unresolvable rather than emit an unverifiable URL.
    logger?.error({ artifactId: artifact.id }, 'resolution: release has no log entry');
    return 'unresolvable_release';
  }

  const manifest = await loadManifest(release.releaseDoc.files, objectStore, logger);
  if (manifest === null) return 'unresolvable_release';

  const entryHash = release.releaseDoc.files[manifest.entry];
  if (entryHash === undefined) {
    // The manifest names an `entry` the signed release does not list — inconsistent.
    logger?.error(
      { artifactId: artifact.id, entry: manifest.entry },
      'resolution: manifest entry path is not in the release file map',
    );
    return 'unresolvable_release';
  }

  const bundle: SignatureBundle = {
    release: release.releaseDoc,
    envelope: release.envelope,
    logEntry: release.logEntry,
  };
  const resolved: ResolvedModule = {
    source: registryId,
    publisher: module.publisher,
    tag: module.tag,
    version: module.version,
    specifier: `${registryId}/${module.tag}`,
    url: servingUrlForHash(entryHash),
    bundle,
  };
  return { module: resolved, sharedScope: manifest.sharedScope ?? {} };
}

/**
 * Resolve a whole gate snapshot into an import-map fragment (FR-7). Every output is
 * qualified by `deps.registryId` (FR-10). The snapshot is assumed to target this
 * registry (the route enforces `snapshot.registry === registryId`).
 */
export async function resolveGateSnapshot(
  snapshot: GateSnapshot,
  deps: ResolveDeps,
): Promise<ImportMapFragment> {
  const shared = snapshot.shared ?? {};

  const resolved: ResolvedModule[] = [];
  const excluded: ExcludedModule[] = [];
  const scopes: Record<string, Record<string, string>> = {};

  for (const module of snapshot.modules) {
    const outcome = await resolveModule(module, deps);
    if (typeof outcome === 'string') {
      excluded.push(excludedFrom(module, outcome));
      continue;
    }

    // Resolve this module's shared-dependency majors against the shell's offers.
    // A scope entry is emitted only for a specifier whose chosen major differs from
    // the shell's default (highest offered) — otherwise the module shares the
    // default instance and needs no scope (GW-D22 "never globals").
    const moduleScope: Record<string, string> = {};
    let sharedScopeMiss = false;
    for (const [specifier, range] of Object.entries(outcome.sharedScope)) {
      const offers = shared[specifier];
      if (offers === undefined || offers.length === 0) {
        // The widget expects the host to satisfy this specifier, but the shell
        // offers nothing for it — a resolve-time miss (GW-D22).
        sharedScopeMiss = true;
        break;
      }
      const chosen = pickOffer(offers, range);
      if (chosen === null) {
        sharedScopeMiss = true;
        break;
      }
      const fallback = defaultOffer(offers);
      if (fallback !== null && chosen.url !== fallback.url) {
        moduleScope[specifier] = chosen.url;
      }
    }

    if (sharedScopeMiss) {
      excluded.push(excludedFrom(module, 'unsatisfied_shared_scope'));
      continue;
    }

    resolved.push(outcome.module);
    if (Object.keys(moduleScope).length > 0) {
      scopes[outcome.module.url] = moduleScope;
    }
  }

  const imports: Record<string, string> = {};
  for (const module of resolved) {
    imports[module.specifier] = module.url;
  }

  return {
    registry: deps.registryId,
    imports,
    scopes,
    modules: resolved,
    excluded,
  };
}
