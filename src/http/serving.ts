/**
 * Serving API — the hash-addressed, read-only read origin (FR-6; SPEC §3, §10).
 *
 * Two anonymous `GET` surfaces, both content-addressed and immutably cacheable so
 * a CDN sits in front of them and the registry API stays off a page load's
 * critical path (SPEC §10):
 *
 *  - `GET /v1/artifacts/:hash` — the exact immutable bytes of an artifact file,
 *    fetched from the object-store origin by content hash. A hash is served only
 *    when a **countersigned release document lists it** ({ path → hash }, SPEC §3);
 *    a hash no signed release pins — an unknown hash, or the review-only source
 *    archive — refuses with `404`. The served bytes therefore always hash-match a
 *    signed release entry.
 *  - `GET /v1/releases/:hash` — the countersigned release document a host caches
 *    and verifies offline (SPEC §10), addressed by the release hash its publisher
 *    signed (`subject.releaseHash`): the `{ path → hash }` map plus the completed
 *    dual-signature envelope and the transparency-log inclusion entry.
 *
 * This surface is **read-only and side-effect-free**: it registers no mutating
 * route, so no published hash can be overwritten or deleted through the API
 * (immutability, SPEC §3), and it emits no per-request audit event (serving is the
 * hot path, never the control plane; SPEC §8, §10). Administrative changes to what
 * is servable happen through the publish/review state transitions, which already
 * audit.
 */
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';

import type { ReleaseDocStore } from '../release/store.js';
import type { ObjectStore } from '../storage/object-store.js';
import { contentTypeForPath } from '../serving/content-type.js';
import { sendError } from './errors.js';

/**
 * Immutable, long-lived cache directive for a content-addressed response. The
 * bytes behind a hash never change, so a CDN and browser may cache them for a
 * year and never revalidate (`immutable`); `public` allows shared CDN caching.
 */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

interface ServingPluginOptions extends FastifyPluginOptions {
  objectStore: ObjectStore;
  releaseDocStore: ReleaseDocStore;
}

/** Set the immutable cache headers common to every served, hash-addressed object. */
function setImmutableHeaders(reply: FastifyReply, contentType: string, etag: string): void {
  reply.header('cache-control', IMMUTABLE_CACHE_CONTROL);
  // The content hash is a strong validator: identical bytes ⇒ identical ETag.
  reply.header('etag', `"${etag}"`);
  reply.header('content-type', contentType);
}

/** True when the caller already holds this exact hash (unquoted or quoted ETag). */
function matchesIfNoneMatch(header: string | undefined, hash: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, '').replace(/^"|"$/g, ''))
    .some((tag) => tag === hash || tag === '*');
}

export async function servingRoutes(
  app: FastifyInstance,
  options: ServingPluginOptions,
): Promise<void> {
  const { objectStore, releaseDocStore } = options;

  app.get<{ Params: { hash: string } }>('/v1/artifacts/:hash', async (request, reply) => {
    const { hash } = request.params;

    // Authority check: serve only a hash a signed release document pins. The
    // returned path (any release that lists this hash) gives the extension the
    // response is typed from. No hit ⇒ the hash is not servable (unknown, or a
    // non-served blob such as the source archive) ⇒ 404.
    const servedPath = await releaseDocStore.findServedPathForHash(hash);
    if (servedPath === null) {
      return sendError(reply, 404, 'unknown_hash', 'no signed release lists this content hash');
    }

    const bytes = await objectStore.getObject(hash);
    if (bytes === null) {
      // A pinned hash whose blob is absent is an origin fault, not a client error:
      // a signed release references bytes the object store should hold.
      request.log.error({ hash, servedPath }, 'serving: released hash missing from object store');
      return sendError(reply, 404, 'blob_missing', 'the object for this hash is not available');
    }

    setImmutableHeaders(reply, contentTypeForPath(servedPath), hash);
    if (matchesIfNoneMatch(request.headers['if-none-match'], hash)) {
      return reply.code(304).send();
    }
    return reply.send(Buffer.from(bytes));
  });

  app.get<{ Params: { hash: string } }>('/v1/releases/:hash', async (request, reply) => {
    const { hash } = request.params;

    const record = await releaseDocStore.findByReleaseHash(hash);
    if (record === null) {
      return sendError(reply, 404, 'unknown_release', 'no signed release has this hash');
    }

    setImmutableHeaders(reply, 'application/json; charset=utf-8', hash);
    if (matchesIfNoneMatch(request.headers['if-none-match'], hash)) {
      return reply.code(304).send();
    }
    // The bytes a host caches and verifies offline (SPEC §10): the { path → hash }
    // release document, the completed dual-signature envelope, and the log entry.
    return reply.send({
      releaseDoc: record.releaseDoc,
      envelope: record.envelope,
      logEntry: record.logEntry,
    });
  });
}
