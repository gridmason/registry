/**
 * Widget catalog — the anonymous list/search surface hosts use to show users what
 * a registry offers (issue #63; the dashboard's Add-Widget picker, and the
 * registry web UI of #59, both read it). Resolution needs an exact
 * `(publisher, tag, version)`; this browses.
 *
 * It lists only **distributable** artifacts — the **same predicate resolution
 * gates on** (`../resolution/distributable`, `isDistributable`), so what the
 * catalog shows and what a host can actually load never drift — grouped into one
 * entry per `(publisher, tag)`: its distributable versions newest-first, and the
 * `name` / `description` / `capabilities` read from the **latest** distributable
 * version's manifest.
 *
 * SCOPE note (registry-v0): the catalog is assembled in-app from the approved
 * artifacts (reusing the resolution predicate rather than a bespoke SQL gate, so
 * there is one definition of "distributable"). Keyset pagination bounds the
 * response; a dedicated indexed query is a later optimization if catalogs grow.
 */
import type { Capability } from '@gridmason/protocol';

import type { ArtifactStore } from '../artifact/store.js';
import type { ArtifactRecord } from '../artifact/types.js';
import type { PublisherStore } from '../publisher/store.js';
import type { ReleaseDocStore } from '../release/store.js';
import { isDistributable } from '../resolution/distributable.js';
import type { RevocationCheck } from '../resolution/index.js';
import type { ObjectStore } from '../storage/object-store.js';

/** A capability as the catalog reports it (the manifest `Capability` shape). */
export interface WidgetCapability {
  readonly api: string;
  readonly scope?: string;
}

/** One catalog entry: a `(publisher, tag)` widget and its distributable versions. */
export interface WidgetSummary {
  /** The publisher's namespace prefix on this registry. */
  readonly publisher: string;
  /** The widget custom-element tag (publisher-prefixed). */
  readonly tag: string;
  /** Human-readable name, from the latest distributable version's manifest. */
  readonly name: string;
  /** Manifest description of the latest version, or `null` when the manifest carries none. */
  readonly description: string | null;
  /** The newest distributable version (`versions[0]`). */
  readonly latestVersion: string;
  /** All distributable versions, newest first. */
  readonly versions: readonly string[];
  /** Declared capabilities of the latest version. */
  readonly capabilities: readonly WidgetCapability[];
}

/** A page of catalog entries plus the opaque cursor for the next page (`null` at the end). */
export interface WidgetListResult {
  readonly widgets: readonly WidgetSummary[];
  readonly nextCursor: string | null;
}

/** The list query: a substring `query`, a `publisher` prefix filter, and keyset paging. */
export interface ListWidgetsParams {
  /** Case-insensitive substring matched against tag **and** name. */
  readonly query?: string;
  /** Exact publisher-prefix filter. */
  readonly publisher?: string;
  /** Page size (already validated/clamped by the route). */
  readonly limit: number;
  /** Opaque keyset cursor from a prior `nextCursor` (route-validated). */
  readonly cursor?: string;
}

/** Structural logger the service writes catalog-origin faults to (Fastify's `request.log` satisfies it). */
export interface WidgetCatalogLogger {
  error(obj: object, msg?: string): void;
}

export interface WidgetCatalogDeps {
  readonly artifactStore: ArtifactStore;
  readonly releaseDocStore: ReleaseDocStore;
  readonly publisherStore: PublisherStore;
  readonly objectStore: ObjectStore;
  /** The same signed-feed revocation seam resolution uses (`state ∧ feed`); absent → state alone. */
  readonly revocationCheck?: RevocationCheck;
  readonly logger?: WidgetCatalogLogger;
}

const MANIFEST_PATH = 'manifest.json';

/** A `(publisher, tag)` keyset key — the catalog's stable sort + cursor. */
interface WidgetKey {
  readonly publisher: string;
  readonly tag: string;
}

/** Encode the opaque keyset cursor — the `(publisher, tag)` of the last returned entry. */
export function encodeCursor(key: WidgetKey): string {
  return Buffer.from(JSON.stringify([key.publisher, key.tag]), 'utf8').toString('base64url');
}

/** Decode a keyset cursor, or `null` when it is not a well-formed one. */
export function decodeCursor(cursor: string): WidgetKey | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return { publisher: parsed[0], tag: parsed[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Lexicographic order on the `(publisher, tag)` keyset — the stable catalog sort. */
function compareKey(a: WidgetKey, b: WidgetKey): number {
  return a.publisher < b.publisher ? -1 : a.publisher > b.publisher ? 1 : a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
}

/** Parse a SemVer-ish string into numeric core + prerelease tail (build metadata ignored). */
function parseVersion(version: string): { nums: [number, number, number]; pre: string } {
  const coreAndPre = version.split('+', 1)[0] ?? version;
  const [core, ...preParts] = coreAndPre.split('-');
  const seg = (core ?? '').split('.');
  const n = (i: number): number => {
    const v = Number(seg[i]);
    return Number.isInteger(v) ? v : 0;
  };
  return { nums: [n(0), n(1), n(2)], pre: preParts.join('-') };
}

/** Descending SemVer order (newest first); a release outranks its prereleases. */
function compareVersionsDesc(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i]! !== pb.nums[i]!) return pb.nums[i]! - pa.nums[i]!;
  }
  if (pa.pre === '' && pb.pre !== '') return -1; // release before prerelease (newest)
  if (pa.pre !== '' && pb.pre === '') return 1;
  return pa.pre < pb.pre ? 1 : pa.pre > pb.pre ? -1 : 0;
}

/** Read the served manifest for name/description/capabilities; defensive (never throws). */
async function readManifestSummary(
  artifact: ArtifactRecord,
  objectStore: ObjectStore,
  logger?: WidgetCatalogLogger,
): Promise<{ name: string; description: string | null; capabilities: WidgetCapability[] }> {
  const fallback = { name: artifact.tag, description: null, capabilities: [] as WidgetCapability[] };
  const manifestHash = artifact.contentHashes[MANIFEST_PATH];
  if (manifestHash === undefined) return fallback;
  const bytes = await objectStore.getObject(manifestHash);
  if (bytes === null) {
    logger?.error({ artifactId: artifact.id, manifestHash }, 'widgets: manifest blob missing for an approved artifact');
    return fallback;
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    manifest = parsed as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const name = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : artifact.tag;
  // `description` is not a formal manifest field (@gridmason/protocol Manifest), so it
  // is read optionally — present when a manifest carries one, `null` otherwise.
  const description = typeof manifest.description === 'string' ? manifest.description : null;
  const capabilities = Array.isArray(manifest.capabilities)
    ? (manifest.capabilities as Capability[])
        .filter((c): c is Capability => typeof c === 'object' && c !== null && typeof c.api === 'string')
        .map((c) => (c.scope !== undefined ? { api: c.api, scope: c.scope } : { api: c.api }))
    : [];
  return { name, description, capabilities };
}

/** A `(publisher, tag)` group of distributable artifacts, before version sorting. */
interface Grouped {
  readonly publisher: string;
  readonly tag: string;
  readonly artifacts: ArtifactRecord[];
}

/**
 * The widget catalog service. Lists distributable widgets grouped by
 * `(publisher, tag)`, newest version first, keyset-paginated on `(publisher, tag)`.
 */
export interface WidgetCatalogService {
  listWidgets(params: ListWidgetsParams): Promise<WidgetListResult>;
}

export function createWidgetCatalogService(deps: WidgetCatalogDeps): WidgetCatalogService {
  const { artifactStore, releaseDocStore, publisherStore, objectStore, revocationCheck, logger } = deps;

  return {
    async listWidgets(params) {
      // Resolve a publisher's prefix once per publisher.
      const prefixCache = new Map<string, string | null>();
      const resolvePrefix = async (publisherId: string): Promise<string | null> => {
        if (prefixCache.has(publisherId)) return prefixCache.get(publisherId)!;
        const record = await publisherStore.findById(publisherId);
        const prefix = record?.prefix ?? null;
        prefixCache.set(publisherId, prefix);
        return prefix;
      };

      // 1. Gather the distributable artifacts — the same predicate resolution gates
      //    on — grouped by (publisher, tag).
      const approved = await artifactStore.listByState('approved');
      const groups = new Map<string, Grouped>();
      for (const artifact of approved) {
        const publisher = await resolvePrefix(artifact.publisherId);
        const revoked = revocationCheck
          ? await revocationCheck.isRevoked({ artifactId: artifact.id, tag: artifact.tag, publisher: publisher ?? '' })
          : false;
        const release = await releaseDocStore.findByArtifact(artifact.id);
        if (!isDistributable({ state: artifact.state, revoked, hasRelease: release !== null, hasLogEntry: release?.logEntry != null })) {
          continue;
        }
        if (publisher === null) {
          logger?.error({ publisherId: artifact.publisherId, tag: artifact.tag }, 'widgets: publisher record missing for a distributable artifact');
          continue;
        }
        const key = `${publisher} ${artifact.tag}`;
        const group = groups.get(key);
        if (group) group.artifacts.push(artifact);
        else groups.set(key, { publisher, tag: artifact.tag, artifacts: [artifact] });
      }

      // 2. Assemble each group's summary from the latest version's manifest.
      const summaries: WidgetSummary[] = [];
      for (const group of groups.values()) {
        const sorted = [...group.artifacts].sort((a, b) => compareVersionsDesc(a.version, b.version));
        const latest = sorted[0]!;
        const { name, description, capabilities } = await readManifestSummary(latest, objectStore, logger);
        summaries.push({
          publisher: group.publisher,
          tag: group.tag,
          name,
          description,
          latestVersion: latest.version,
          versions: sorted.map((a) => a.version),
          capabilities,
        });
      }

      // 3. Filter (publisher prefix + case-insensitive substring on tag/name).
      const q = params.query?.toLowerCase();
      const filtered = summaries.filter((w) => {
        if (params.publisher !== undefined && w.publisher !== params.publisher) return false;
        if (q !== undefined && q !== '' && !w.tag.toLowerCase().includes(q) && !w.name.toLowerCase().includes(q)) return false;
        return true;
      });

      // 4. Stable keyset sort + page after the cursor.
      filtered.sort(compareKey);
      const after = params.cursor ? decodeCursor(params.cursor) : null;
      const eligible = after ? filtered.filter((w) => compareKey(w, after) > 0) : filtered;
      const window = eligible.slice(0, params.limit + 1);
      const hasMore = window.length > params.limit;
      const widgets = hasMore ? window.slice(0, params.limit) : window;
      const last = widgets[widgets.length - 1];
      const nextCursor = hasMore && last ? encodeCursor(last) : null;

      return { widgets, nextCursor };
    },
  };
}
