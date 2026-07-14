/**
 * Resolution API route (FR-7, FR-10; SPEC §8, §9).
 *
 * `POST /v1/resolve` — the single anonymous surface host shells call to turn a
 * gate snapshot into an import-map fragment (hash-pinned entry URLs + per-module
 * signature bundles + shared-dependency `scopes`). It is **anonymous** and takes
 * **no deployment registration**: a registry is never a control plane a deployment
 * must phone (SPEC §1, §8). The output is qualified by this registry's id so a host
 * merging fragments from several registries keys each by source-qualified
 * `(registry, publisher, tag)` identity (SPEC §9, FR-10).
 *
 * The surface reads distribution state and emits no per-request audit event — like
 * serving (#12) it is off the control plane. It registers only the one `POST`
 * route, which resolves published, countersigned, non-revoked releases; a revoked
 * or killed remote never appears in a fragment (SPEC §6).
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import type { ArtifactStore } from '../artifact/store.js';
import type { PublisherStore } from '../publisher/store.js';
import type { ReleaseDocStore } from '../release/store.js';
import { resolveGateSnapshot, type RevocationCheck } from '../resolution/index.js';
import type { GateModule, GateSnapshot } from '../resolution/index.js';
import type { ObjectStore } from '../storage/object-store.js';
import { sendError } from './errors.js';

interface ResolutionPluginOptions extends FastifyPluginOptions {
  publisherStore: PublisherStore;
  artifactStore: ArtifactStore;
  releaseDocStore: ReleaseDocStore;
  objectStore: ObjectStore;
  registryId: string;
  /** Optional signed-feed revocation cross-check (#14 seam). */
  revocationCheck?: RevocationCheck;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ParseResult =
  | { readonly ok: true; readonly snapshot: GateSnapshot }
  | { readonly ok: false; readonly message: string };

/**
 * Structurally validate a gate-snapshot body. Total and side-effect free: it
 * returns a typed message rather than throwing, so the route answers a clean
 * `400 invalid_request`. Identity/state checks happen in the resolver, not here.
 */
function parseGateSnapshot(body: unknown): ParseResult {
  if (!isPlainObject(body)) return { ok: false, message: 'request body must be a JSON object' };

  if (typeof body.registry !== 'string' || body.registry === '') {
    return { ok: false, message: 'registry is required and must be a non-empty string' };
  }
  if (!Array.isArray(body.modules)) {
    return { ok: false, message: 'modules is required and must be an array' };
  }

  const modules: GateModule[] = [];
  for (const raw of body.modules) {
    if (!isPlainObject(raw)) {
      return { ok: false, message: 'each module must be an object' };
    }
    const { publisher, tag, version } = raw;
    if (typeof publisher !== 'string' || publisher === '') {
      return { ok: false, message: 'each module needs a non-empty publisher' };
    }
    if (typeof tag !== 'string' || tag === '') {
      return { ok: false, message: 'each module needs a non-empty tag' };
    }
    if (typeof version !== 'string' || version === '') {
      return { ok: false, message: 'each module needs a non-empty version' };
    }
    modules.push({ publisher, tag, version });
  }

  let shared: GateSnapshot['shared'];
  if (body.shared !== undefined) {
    if (!isPlainObject(body.shared)) {
      return { ok: false, message: 'shared must be an object keyed by specifier' };
    }
    const built: Record<string, { major: number; url: string }[]> = {};
    for (const [specifier, offers] of Object.entries(body.shared)) {
      if (!Array.isArray(offers)) {
        return { ok: false, message: `shared["${specifier}"] must be an array of offers` };
      }
      const list: { major: number; url: string }[] = [];
      for (const offer of offers) {
        if (
          !isPlainObject(offer) ||
          !Number.isInteger(offer.major) ||
          (offer.major as number) < 0 ||
          typeof offer.url !== 'string' ||
          offer.url === ''
        ) {
          return {
            ok: false,
            message: `shared["${specifier}"] offers need an integer major and a non-empty url`,
          };
        }
        list.push({ major: offer.major as number, url: offer.url });
      }
      built[specifier] = list;
    }
    shared = built;
  }

  return { ok: true, snapshot: { registry: body.registry, modules, shared } };
}

export async function resolutionRoutes(
  app: FastifyInstance,
  options: ResolutionPluginOptions,
): Promise<void> {
  const { publisherStore, artifactStore, releaseDocStore, objectStore, registryId } = options;

  app.post('/v1/resolve', async (request, reply) => {
    const parsed = parseGateSnapshot(request.body);
    if (!parsed.ok) {
      return sendError(reply, 400, 'invalid_request', parsed.message);
    }

    // The host pins each prefix to one registry, so a snapshot targets exactly one
    // (SPEC §9). A snapshot addressed to a different registry is a configuration
    // error the host must fix, not something to partially resolve.
    if (parsed.snapshot.registry !== registryId) {
      return sendError(
        reply,
        400,
        'wrong_registry',
        `this registry is "${registryId}"; the snapshot targets "${parsed.snapshot.registry}"`,
      );
    }

    const fragment = await resolveGateSnapshot(parsed.snapshot, {
      publisherStore,
      artifactStore,
      releaseDocStore,
      objectStore,
      registryId,
      revocationCheck: options.revocationCheck,
      logger: request.log,
    });

    // The fragment is derived from immutable, content-addressed releases, but the
    // *set* a snapshot maps to can change as distribution state flips (a kill), so
    // it is not marked immutable — the host re-resolves within the §6 TTL.
    return reply.send(fragment);
  });
}
