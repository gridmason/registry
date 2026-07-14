/**
 * Publish API — artifact upload, content-hash computation, immutability, envelope
 * intake (FR-1; SPEC §2, §3, §8).
 *
 * - `POST /v1/artifacts` — an authenticated publisher uploads an artifact
 *   (manifest + `entry` + chunks + schemas + docs) plus the signed source archive
 *   (GW-D19 interim) and the publisher signature envelope. The registry
 *   content-addresses every part with `@gridmason/protocol` hashing (so the hashes
 *   match the protocol's published vectors), stores the raw immutable blobs by
 *   hash in the object store, and records a `submitted` artifact. It does **not**
 *   run checks or countersign — it hands a `submitted` artifact to the
 *   automated-review stage (#8).
 *
 * The endpoint enforces two bindings before it accepts anything: the bearer token
 * verifies against an allowlisted OIDC issuer (SPEC §2), and the artifact `tag`
 * falls under that publisher's registered namespace prefix (SPEC §5) — the
 * identity↔namespace check that stops a publisher shipping under another's prefix.
 * Version immutability (a `(publisher, tag, version)` is published once, SPEC §3)
 * is enforced by the store's unique constraint and answered as `409`. Every
 * accepted upload and every denial emits an `AuditEvent` (FR-12).
 *
 * Envelope handling this phase is **structural only** (see `../artifact/envelope`):
 * a malformed/missing envelope is refused, a well-formed one is stored opaquely;
 * cryptographic verification is deferred to countersign (#10).
 */
import { hashBytes, lintTag, type MultihashString } from '@gridmason/protocol';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import { emitAuditEvent } from '../audit/index.js';
import { extractBearerToken, type OidcVerifier } from '../auth/oidc.js';
import { isStructurallyValidEnvelope } from '../artifact/envelope.js';
import { toArtifactResponse } from '../artifact/presenter.js';
import type { ArtifactStore } from '../artifact/store.js';
import { parseArtifactUpload } from '../artifact/upload.js';
import { composeOidcIdentity } from '../publisher/types.js';
import type { PublisherStore } from '../publisher/store.js';
import type { ObjectStore } from '../storage/object-store.js';
import { sendError } from './errors.js';
import { OIDC_REJECTION_RESPONSES } from './oidc-rejection.js';

interface PublishPluginOptions extends FastifyPluginOptions {
  publisherStore: PublisherStore;
  artifactStore: ArtifactStore;
  objectStore: ObjectStore;
  registryId: string;
  verifier: OidcVerifier;
}

export async function publishRoutes(
  app: FastifyInstance,
  options: PublishPluginOptions,
): Promise<void> {
  const { publisherStore, artifactStore, objectStore, registryId, verifier } = options;

  app.post('/v1/artifacts', async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      return sendError(reply, 401, 'missing_token', 'a bearer token is required');
    }

    const verified = await verifier.verify(token);
    if (!verified.ok) {
      // The token failed verification, so its claims are untrusted — the event
      // names only the reason, not an identity (matches publisher.register.denied).
      emitAuditEvent('anonymous', 'publish.denied', `publish:${verified.reason}`);
      const { status, code, message } = OIDC_REJECTION_RESPONSES[verified.reason];
      return sendError(reply, status, code, message);
    }
    const { issuer, subject } = verified.identity;
    const actor = composeOidcIdentity(issuer, subject);

    // A verified identity must own a publisher record before it can publish: the
    // namespace prefix lives on that record (#6).
    const publisher = await publisherStore.findByIdentity(issuer, subject);
    if (!publisher) {
      emitAuditEvent(actor, 'publish.denied', 'publish:not-registered');
      return sendError(
        reply,
        403,
        'not_registered',
        'no publisher is registered for this identity',
      );
    }

    const parsed = parseArtifactUpload(request.body, isStructurallyValidEnvelope);
    if (!parsed.ok) {
      return sendError(reply, 400, parsed.code, parsed.message);
    }
    const { tag, version, files, sourceArchive, envelope } = parsed.upload;

    // The tag must fall under the publisher's registered prefix (SPEC §5). A
    // structural tag defect is a `400`; a well-formed tag outside the prefix is a
    // `403` authorization refusal (a publisher shipping under another's namespace).
    const lint = lintTag(tag, publisher.prefix);
    if (!lint.ok) {
      const outsidePrefixOnly = lint.violations.every(
        (v) => v.code === 'missing-publisher-prefix',
      );
      if (outsidePrefixOnly) {
        emitAuditEvent(actor, 'publish.denied', 'publish:tag-not-in-prefix');
        return sendError(
          reply,
          403,
          'tag_not_in_prefix',
          `tag "${tag}" is not under this publisher's prefix "${publisher.prefix}"`,
        );
      }
      return sendError(reply, 400, 'invalid_tag', `tag "${tag}" is not a valid widget tag`);
    }

    // Content-address every served part and the source archive with the protocol
    // hashing (SHA-256 over exact served bytes, SPEC §3) — the hashes match the
    // `@gridmason/protocol` vectors.
    const contentHashes: Record<string, MultihashString> = {};
    for (const file of files) {
      contentHashes[file.path] = await hashBytes(file.bytes);
    }
    const sourceArchiveRef = await hashBytes(sourceArchive);

    // Store the raw immutable blobs by hash first. Content-addressed writes are
    // idempotent, so this is safe to retry and guarantees an artifact row never
    // references a blob that was not written. The release document that pins
    // {path → hash} is emitted later at countersign time, not here.
    await Promise.all([
      ...files.map((file) => objectStore.putObject(contentHashes[file.path]!, file.bytes)),
      objectStore.putObject(sourceArchiveRef, sourceArchive),
    ]);

    const created = await artifactStore.create({
      publisherId: publisher.id,
      tag,
      version,
      contentHashes,
      sourceArchiveRef,
      envelope,
    });
    if (!created.ok) {
      // Immutability (SPEC §3): a published (publisher, tag, version) is never
      // overwritten. The reviewed hash is the runnable artifact.
      emitAuditEvent(actor, 'publish.denied', 'publish:duplicate-version');
      return sendError(
        reply,
        409,
        'version_exists',
        `version "${version}" of "${tag}" is already published and is immutable`,
      );
    }

    emitAuditEvent(actor, 'publish.submitted', created.record.id);
    reply.code(201);
    return toArtifactResponse(created.record, registryId);
  });
}
