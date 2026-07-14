/**
 * Release re-drive ops endpoint (#38; SPEC §8 Ops API, FR-12).
 *
 * `POST /v1/ops/artifacts/:id/redrive-release` — **operator-only**. Completes an
 * artifact left `approved` but unpublished after a transparency-log outage by
 * re-running the countersign stage (see {@link ReleaseRedriveService}). Idempotent:
 * an artifact that already has a release doc returns `409 already_released`, so an
 * operator can safely retry.
 *
 * Gated on the same operator set as the revocation ops endpoints (#14), via the
 * shared operator-auth seam — every operator denial is audited (`ops.denied`); the
 * re-driven release itself audits `release.countersigned` / `release.logged` (or
 * `release.log_failed` on a still-failing log) through the reused stage.
 */
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';

import type { OidcVerifier } from '../auth/oidc.js';
import type { CountersignFailure } from '../countersign/stage.js';
import type { RedriveRejection, ReleaseRedriveService } from '../countersign/redrive.js';
import { sendError } from './errors.js';
import { authenticateOperator } from './operator-auth.js';

interface ReleaseOpsPluginOptions extends FastifyPluginOptions {
  service: ReleaseRedriveService;
  verifier: OidcVerifier;
  /** The configured operator set, in `composeOidcIdentity` composite form. */
  operatorIdentities: readonly string[];
}

/** Map a re-drive rejection (no stage run) to its HTTP response. */
function sendRejection(reply: FastifyReply, rejection: RedriveRejection): unknown {
  switch (rejection) {
    case 'not-found':
      return sendError(reply, 404, 'not_found', 'no artifact with that id');
    case 'not-approved':
      return sendError(
        reply,
        409,
        'not_approved',
        'only an approved artifact can be re-driven (it is rejected, revoked, killed, or still in review)',
      );
    case 'already-released':
      return sendError(
        reply,
        409,
        'already_released',
        'the artifact already has a release document; nothing to re-drive',
      );
    case 'review-case-missing':
      return sendError(
        reply,
        409,
        'review_case_missing',
        'the artifact has no decided review case; cannot recover the approval context',
      );
  }
}

/** Map a stage failure (the re-drive ran but did not publish) to its HTTP response. */
function sendStageFailure(reply: FastifyReply, reason: CountersignFailure): unknown {
  switch (reason) {
    case 'log-append-failed':
      // The transparency log is still failing; the artifact remains approved-
      // unpublished and the operator can re-drive again later. Retryable → 503.
      return sendError(
        reply,
        503,
        'log_unavailable',
        'the transparency log could not be appended to; the release was not published — retry later',
      );
    case 'envelope-unusable':
    case 'release-hash-mismatch':
    case 'persist-failed':
      // A structural fault (a bad envelope, drifted hashes, or a storage error):
      // re-driving will not fix it, so surface it as a server-side failure.
      return sendError(
        reply,
        500,
        'redrive_failed',
        `the release could not be produced (${reason})`,
      );
  }
}

export function releaseOpsRoutes(app: FastifyInstance, options: ReleaseOpsPluginOptions): void {
  const { service, verifier } = options;
  const operators = new Set(options.operatorIdentities);

  app.post<{ Params: { id: string } }>(
    '/v1/ops/artifacts/:id/redrive-release',
    async (request, reply: FastifyReply): Promise<unknown> => {
      const auth = await authenticateOperator(request, reply, verifier, operators);
      if (!auth.ok) return auth.body;

      const outcome = await service.redrive(request.params.id);
      if (!outcome.ok) return sendRejection(reply, outcome.rejection);
      if (!outcome.result.ok) return sendStageFailure(reply, outcome.result.reason);

      reply.code(201);
      const { releaseDoc, logEntry } = outcome.result;
      return {
        artifactId: releaseDoc.artifactId,
        releaseDocId: releaseDoc.id,
        logIndex: logEntry.index,
      };
    },
  );
}
