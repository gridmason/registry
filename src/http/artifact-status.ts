/**
 * Publisher-facing artifact status + appeal API (FR-11; SPEC §4). The surface
 * `gridmason publish` polls after upload and `gridmason appeal` calls:
 *
 * - `GET  /v1/artifacts/:id/status` — the artifact's review state + findings
 *                                     (keyed by the shared `@gridmason/cli/checks`
 *                                     check ids).
 * - `POST /v1/artifacts/:id/appeal` — route a rejected submission to a second
 *                                     reviewer (never the original — SPEC §4).
 *
 * The status read is served at `/v1/artifacts/:id/status`, **not** the CLI's
 * forward-contract `/v1/artifacts/:id`: that bare path is already the frozen,
 * shipped **hash-addressed serving origin** (`GET /v1/artifacts/:hash`,
 * docs/serving.md, FR-6), and Fastify cannot mount two `GET` handlers on the same
 * `/v1/artifacts/:param` template. The `/status` suffix is the minimal
 * non-colliding path; the appeal endpoint keeps the CLI's exact path (its
 * `/appeal` suffix does not collide). This is a documented deviation the CLI must
 * absorb in its next status-poll bump (see docs/api/artifact-status.md).
 *
 * Both are **publisher-authenticated and owner-scoped**: the caller presents a
 * bearer token verified exactly as publish intake verifies it (OIDC discovery →
 * JWKS, allowlisted issuers, asymmetric algorithms only, fail-closed), the
 * verified identity must own a publisher record, and the artifact must belong to
 * that publisher. A well-formed request for an artifact the caller does not own is
 * answered `404 not_found` — the same response as an unknown id — so the endpoint
 * is not an enumeration oracle for other publishers' artifact ids.
 *
 * This mirrors the reviewer-only lane (`src/http/review`) but from the publisher's
 * side: a reviewer sees the whole queue, a publisher sees only the decision on
 * their own artifact. The findings projection (`src/review/status`) matches the
 * CLI's forward contract so `publish` prints a rejection's findings in the same
 * vocabulary local `lint` uses.
 */
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';

import { emitAuditEvent } from '../audit/index.js';
import { extractBearerToken, type OidcVerifier } from '../auth/oidc.js';
import { toArtifactResponse } from '../artifact/presenter.js';
import type { ArtifactRecord } from '../artifact/types.js';
import type { ArtifactStore } from '../artifact/store.js';
import { composeOidcIdentity } from '../publisher/types.js';
import type { PublisherStore } from '../publisher/store.js';
import type { AppealStage, AppealRejection } from '../review/appeal.js';
import { toPublisherArtifactStatus } from '../review/status.js';
import type { ReviewCaseStore } from '../review/store.js';
import { sendError } from './errors.js';
import { OIDC_REJECTION_RESPONSES } from './oidc-rejection.js';

interface ArtifactStatusPluginOptions extends FastifyPluginOptions {
  publisherStore: PublisherStore;
  artifactStore: ArtifactStore;
  reviewCaseStore: ReviewCaseStore;
  appealStage: AppealStage;
  verifier: OidcVerifier;
  registryId: string;
}

/** A resolved owned artifact, or a response already sent (the caller returns its body). */
type OwnedArtifactAuth =
  | { readonly ok: true; readonly artifact: ArtifactRecord; readonly actor: string }
  | { readonly ok: false; readonly body: unknown };

export async function artifactStatusRoutes(
  app: FastifyInstance,
  options: ArtifactStatusPluginOptions,
): Promise<void> {
  const { publisherStore, artifactStore, reviewCaseStore, appealStage, verifier, registryId } =
    options;

  /**
   * Authenticate the bearer token and resolve the artifact it may act on: the
   * verified identity must own a publisher record, and `:id` must be that
   * publisher's artifact. On any failure the response is already sent (and the
   * authenticated denial audited under `<action>.denied`); the caller returns
   * `body`. `action` names the audit verb (`artifact.status` / `artifact.appeal`).
   */
  async function resolveOwnedArtifact(
    request: { headers: { authorization?: string }; params: { id: string } },
    reply: FastifyReply,
    action: string,
  ): Promise<OwnedArtifactAuth> {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      return { ok: false, body: sendError(reply, 401, 'missing_token', 'a bearer token is required') };
    }

    const verified = await verifier.verify(token);
    if (!verified.ok) {
      // The token failed verification, so its claims are untrusted — name only the reason.
      emitAuditEvent('anonymous', `${action}.denied`, `${action}:${verified.reason}`);
      const { status, code, message } = OIDC_REJECTION_RESPONSES[verified.reason];
      return { ok: false, body: sendError(reply, status, code, message) };
    }
    const { issuer, subject } = verified.identity;
    const actor = composeOidcIdentity(issuer, subject);

    const publisher = await publisherStore.findByIdentity(issuer, subject);
    if (!publisher) {
      emitAuditEvent(actor, `${action}.denied`, `${action}:not-registered`);
      return {
        ok: false,
        body: sendError(reply, 403, 'not_registered', 'no publisher is registered for this identity'),
      };
    }

    const artifact = await artifactStore.findById(request.params.id);
    // A missing artifact and one owned by a different publisher are answered
    // identically (404), so the endpoint never reveals another publisher's ids.
    if (!artifact || artifact.publisherId !== publisher.id) {
      emitAuditEvent(actor, `${action}.denied`, `${action}:not-found`);
      return { ok: false, body: sendError(reply, 404, 'not_found', 'no artifact with that id') };
    }
    return { ok: true, artifact, actor };
  }

  app.get<{ Params: { id: string } }>('/v1/artifacts/:id/status', async (request, reply) => {
    const auth = await resolveOwnedArtifact(request, reply, 'artifact.status');
    if (!auth.ok) return auth.body;
    // A status read is polled in a loop by `publish`; it is not a state
    // transition, so it emits no audit event (SPEC §10 audits transitions).
    const reviewCase = await reviewCaseStore.findByArtifact(auth.artifact.id);
    return toPublisherArtifactStatus(auth.artifact, reviewCase, registryId);
  });

  app.post<{ Params: { id: string } }>('/v1/artifacts/:id/appeal', async (request, reply) => {
    const auth = await resolveOwnedArtifact(request, reply, 'artifact.appeal');
    if (!auth.ok) return auth.body;

    const result = await appealStage.appeal(auth.artifact, auth.actor);
    if (!result.ok) {
      return sendAppealRejection(reply, result.rejection, auth.actor);
    }

    // The appeal stage emits `artifact.appeal` on the re-open transition. Echo the
    // artifact record back (state now `reviewing`), the shape the CLI's appeal
    // client parses.
    reply.code(201);
    return toArtifactResponse(result.outcome.artifact, registryId);
  });

  /** Map an {@link AppealRejection} to its HTTP response, auditing the authenticated denial. */
  function sendAppealRejection(
    reply: FastifyReply,
    rejection: AppealRejection,
    actor: string,
  ): unknown {
    switch (rejection.kind) {
      case 'not-appealable':
        // Only a rejected submission can be appealed (CLI contract: 409 not_appealable).
        emitAuditEvent(actor, 'artifact.appeal.denied', 'appeal:not-appealable');
        return sendError(
          reply,
          409,
          'not_appealable',
          'only a rejected artifact can be appealed',
        );
      case 'no-review-case':
        // A rejected artifact with no review case is an integrity fault: there is
        // no report to map the second reviewer's findings against, so fail closed.
        emitAuditEvent(actor, 'artifact.appeal.denied', 'appeal:no-review-case');
        return sendError(
          reply,
          409,
          'appeal_unavailable',
          'the artifact has no review case to appeal',
        );
      case 'transition-failed':
        // The artifact left `rejected` concurrently (a revoke/kill) before the
        // re-open state moved.
        emitAuditEvent(actor, 'artifact.appeal.denied', 'appeal:transition-failed');
        return sendError(
          reply,
          409,
          'transition_failed',
          'the artifact was no longer rejected when the appeal was applied',
        );
    }
  }
}
