/**
 * Revocation & kill feed API (FR-8, FR-12; SPEC §6, §8).
 *
 * Two surfaces with opposite audiences:
 *
 * - `GET  /v1/revocation/feed`            — **anonymous**. The signed revocation &
 *   kill feed a host polls: the protocol {@link import('@gridmason/protocol').RevocationFeed}
 *   document plus the registry signature over its canonical bytes. This is
 *   distribution state, published for anyone to consume (like the resolution
 *   surface), so it takes no bearer token.
 * - `POST /v1/ops/artifacts/:id/revoke`   — **operator-only**. Withdraw an artifact.
 * - `POST /v1/ops/artifacts/:id/kill`     — **operator-only**. Kill an artifact.
 *
 * The ops endpoints are the SCOPE-minimal Ops API (no console): a bearer token
 * must verify against an allowlisted OIDC issuer (SPEC §2) **and** name an
 * identity in this registry's configured operator set (the config-listed pattern,
 * mirroring the reviewer roster). Every revoke/kill emits an `AuditEvent`, as does
 * every denial.
 *
 * The feed is signed with the registry countersign identity (SPEC §6 — same trust
 * root as release approval); the feed endpoint mounts only when that key is
 * configured (see `server.ts`).
 */
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';

import { type OidcVerifier } from '../auth/oidc.js';
import type { CountersignIdentity } from '../countersign/identity.js';
import { composeOidcIdentity } from '../publisher/types.js';
import {
  buildRevocationFeed,
  signRevocationFeed,
  type FeedEntryStore,
  type RevocationRejection,
  type RevocationService,
} from '../revocation/index.js';
import { sendError } from './errors.js';
import { authenticateOperator } from './operator-auth.js';

/** The advisory severities a revoke/kill may carry (protocol `RevocationSeverity`). */
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
type Severity = (typeof SEVERITIES)[number];

interface RevocationPluginOptions extends FastifyPluginOptions {
  service: RevocationService;
  feedEntryStore: FeedEntryStore;
  countersignIdentity: CountersignIdentity;
  verifier: OidcVerifier;
  /** The configured operator set, in `composeOidcIdentity` composite form. */
  operatorIdentities: readonly string[];
  registryId: string;
  /** Freshness window (seconds) stamped on each served feed. */
  feedTtlSeconds: number;
}

interface IssueBody {
  severity?: unknown;
  reason?: unknown;
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

/** Map a service {@link RevocationRejection} to its HTTP response. */
function sendRejection(reply: FastifyReply, rejection: RevocationRejection): unknown {
  switch (rejection) {
    case 'not-found':
      return sendError(reply, 404, 'not_found', 'no artifact with that id');
    case 'invalid-state':
      // The artifact is not in a state that can be revoked/killed: never approved,
      // or already killed. Distinct from not-found so an operator can tell them apart.
      return sendError(
        reply,
        409,
        'invalid_state',
        'the artifact is not in a distributable state (not approved, or already killed)',
      );
  }
}

export async function revocationRoutes(
  app: FastifyInstance,
  options: RevocationPluginOptions,
): Promise<void> {
  const {
    service,
    feedEntryStore,
    countersignIdentity,
    verifier,
    registryId,
    feedTtlSeconds,
  } = options;
  const operators = new Set(options.operatorIdentities);

  app.get('/v1/revocation/feed', async () => {
    // Anonymous, generated live: the feed is current as of `issuedAt = now`, so a
    // revoke/kill appended since the last fetch is reflected on this one (a kill
    // flips the feed within one cycle, well inside the ≤ 1 h online bound).
    const snapshot = await feedEntryStore.snapshot();
    const feed = buildRevocationFeed({
      registryId,
      snapshot,
      issuedAt: Date.now(),
      ttlSeconds: feedTtlSeconds,
    });
    return signRevocationFeed(feed, countersignIdentity);
  });

  /** Shared handler for the two ops endpoints; `action` selects revoke vs kill. */
  function issueHandler(action: 'revoke' | 'kill') {
    return async (
      request: {
        headers: { authorization?: string };
        params: { id: string };
        body?: unknown;
      },
      reply: FastifyReply,
    ): Promise<unknown> => {
      const auth = await authenticateOperator(request, reply, verifier, operators);
      if (!auth.ok) return auth.body;

      const body = (request.body ?? {}) as IssueBody;
      if (!isSeverity(body.severity)) {
        return sendError(
          reply,
          400,
          'invalid_request',
          `severity is required and must be one of ${SEVERITIES.join(', ')}`,
        );
      }
      if (typeof body.reason !== 'string' || body.reason.trim() === '') {
        return sendError(reply, 400, 'invalid_request', 'reason is required and must be a non-empty string');
      }

      const actor = composeOidcIdentity(auth.identity.issuer, auth.identity.subject);
      const input = {
        artifactId: request.params.id,
        severity: body.severity,
        reason: body.reason,
        actor,
      };
      const result =
        action === 'revoke' ? await service.revoke(input) : await service.kill(input);
      if (!result.ok) return sendRejection(reply, result.rejection);

      reply.code(201);
      return {
        artifactId: result.outcome.artifact.id,
        artifactState: result.outcome.artifact.state,
        state: result.outcome.state,
        seq: result.outcome.seq,
      };
    };
  }

  app.post<{ Params: { id: string } }>('/v1/ops/artifacts/:id/revoke', issueHandler('revoke'));
  app.post<{ Params: { id: string } }>('/v1/ops/artifacts/:id/kill', issueHandler('kill'));
}
