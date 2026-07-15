/**
 * Human review lane API — queue + verdict (FR-4; SPEC §4, §4a, §8).
 *
 * The minimal ops/queue surface the SCOPE-minimal cut ships (no console — CLI/API
 * only):
 *
 * - `GET  /v1/review/queue`            — artifacts awaiting a human verdict.
 * - `GET  /v1/review/cases/:id`        — one case + its automated checks report.
 * - `POST /v1/review/cases/:id/verdict`— record approve/reject + findings.
 *
 * Every endpoint is reviewer-only: it is operational data ahead of approval, not
 * the public resolution surface, so a bearer token must both verify against an
 * allowlisted OIDC issuer (SPEC §2) **and** name an identity in this registry's
 * configured reviewer set (the v0 reviewer roster — no reviewer console this
 * phase, SCOPE cut). The verdict route additionally enforces reviewer≠author +
 * the disclosed flagship waiver in the {@link HumanReviewLane}. Every denial and
 * every verdict emits an `AuditEvent` (FR-12).
 */
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';

import { emitAuditEvent } from '../audit/index.js';
import { extractBearerToken, type OidcIdentity, type OidcVerifier } from '../auth/oidc.js';
import { composeOidcIdentity } from '../publisher/types.js';
import type { HumanReviewLane, VerdictRejection } from '../review/human/lane.js';
import {
  toReviewCaseResponse,
  toReviewQueueItem,
} from '../review/human/presenter.js';
import type { VerdictDecision } from '../review/human/types.js';
import { sendError } from './errors.js';
import { OIDC_REJECTION_RESPONSES } from './oidc-rejection.js';

interface ReviewPluginOptions extends FastifyPluginOptions {
  lane: HumanReviewLane;
  verifier: OidcVerifier;
  /** The configured reviewer set, in `composeOidcIdentity` composite form. */
  reviewerIdentities: readonly string[];
  registryId: string;
}

/** A resolved reviewer, or a response already sent (the caller returns its body). */
type ReviewerAuth =
  | { readonly ok: true; readonly identity: OidcIdentity }
  | { readonly ok: false; readonly body: unknown };

interface VerdictBody {
  decision?: unknown;
  findings?: unknown;
}

const DECISIONS: readonly VerdictDecision[] = ['approve', 'reject'];

function isDecision(value: unknown): value is VerdictDecision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value);
}

/** Map a lane {@link VerdictRejection} to its HTTP response. */
function sendVerdictRejection(reply: FastifyReply, rejection: VerdictRejection): unknown {
  switch (rejection.kind) {
    case 'case-not-found':
      return sendError(reply, 404, 'not_found', 'no review case with that id');
    case 'not-in-review':
      return sendError(
        reply,
        409,
        'not_in_review',
        'the artifact is not awaiting review (already decided or auto-rejected)',
      );
    case 'author-unresolved':
      // The artifact references a publisher record we cannot load, so reviewer≠author
      // cannot be proven — fail closed rather than let the verdict through.
      return sendError(
        reply,
        409,
        'author_unresolved',
        "the artifact's publisher record could not be resolved; refusing the verdict",
      );
    case 'transition-failed':
      // The artifact left `reviewing` concurrently (a revoke/kill) after the verdict
      // was recorded but before the state moved.
      return sendError(
        reply,
        409,
        'transition_failed',
        'the artifact was no longer awaiting review when the verdict was applied',
      );
    case 'self-review':
      return sendError(
        reply,
        403,
        'self_review_forbidden',
        'a publisher cannot review their own artifact (reviewer ≠ author)',
      );
    case 'appeal-original-reviewer':
      // SPEC §4: an appeal routes to a second reviewer, never the original — the
      // reviewer who cast the rejection cannot decide the re-review.
      return sendError(
        reply,
        403,
        'appeal_reviewer_forbidden',
        'the original reviewer cannot decide an appeal (appeal reviewer ≠ original reviewer)',
      );
    case 'findings':
      // A well-formed but semantically invalid finding (a check id absent from the
      // report) is a 422; a structurally malformed payload is a 400.
      return rejection.code === 'unknown-check-id'
        ? sendError(reply, 422, 'unknown_check_id', rejection.message)
        : sendError(reply, 400, 'invalid_request', rejection.message);
    case 'already-decided':
      return sendError(
        reply,
        409,
        'already_decided',
        'this review case already has a verdict',
      );
  }
}

export async function reviewRoutes(
  app: FastifyInstance,
  options: ReviewPluginOptions,
): Promise<void> {
  const { lane, verifier, registryId } = options;
  const reviewers = new Set(options.reviewerIdentities);

  /**
   * Authenticate the bearer token and authorise it as a reviewer. On failure the
   * response is already sent (and the denial audited); the caller returns `body`.
   */
  async function authenticateReviewer(
    request: { headers: { authorization?: string } },
    reply: FastifyReply,
  ): Promise<ReviewerAuth> {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      return { ok: false, body: sendError(reply, 401, 'missing_token', 'a bearer token is required') };
    }
    const verified = await verifier.verify(token);
    if (!verified.ok) {
      // The token failed verification, so its claims are untrusted — name only the reason.
      emitAuditEvent('anonymous', 'review.denied', `review:${verified.reason}`);
      const { status, code, message } = OIDC_REJECTION_RESPONSES[verified.reason];
      return { ok: false, body: sendError(reply, status, code, message) };
    }
    const identity = verified.identity;
    const reviewerId = composeOidcIdentity(identity.issuer, identity.subject);
    if (!reviewers.has(reviewerId)) {
      emitAuditEvent(reviewerId, 'review.denied', 'review:not-a-reviewer');
      return {
        ok: false,
        body: sendError(
          reply,
          403,
          'not_a_reviewer',
          'this identity is not on the registry reviewer set',
        ),
      };
    }
    return { ok: true, identity };
  }

  app.get('/v1/review/queue', async (request, reply) => {
    const auth = await authenticateReviewer(request, reply);
    if (!auth.ok) return auth.body;
    const pending = await lane.listQueue();
    return { cases: pending.map((item) => toReviewQueueItem(item, registryId)) };
  });

  app.get<{ Params: { id: string } }>('/v1/review/cases/:id', async (request, reply) => {
    const auth = await authenticateReviewer(request, reply);
    if (!auth.ok) return auth.body;
    const found = await lane.getCase(request.params.id);
    if (!found) {
      return sendError(reply, 404, 'not_found', 'no review case with that id');
    }
    return toReviewCaseResponse(found, registryId);
  });

  app.post<{ Params: { id: string } }>(
    '/v1/review/cases/:id/verdict',
    async (request, reply) => {
      const auth = await authenticateReviewer(request, reply);
      if (!auth.ok) return auth.body;

      const body = (request.body ?? {}) as VerdictBody;
      if (!isDecision(body.decision)) {
        return sendError(
          reply,
          400,
          'invalid_request',
          'decision is required and must be "approve" or "reject"',
        );
      }

      const result = await lane.submitVerdict({
        caseId: request.params.id,
        reviewer: auth.identity,
        decision: body.decision,
        findings: body.findings,
      });
      if (!result.ok) {
        return sendVerdictRejection(reply, result.rejection);
      }

      const { reviewCase, artifact, waiverUsed } = result.outcome;
      reply.code(201);
      return {
        caseId: reviewCase.id,
        decision: reviewCase.verdict,
        artifactState: artifact.state,
        waiverUsed,
        findings: reviewCase.findings ?? [],
      };
    },
  );
}
