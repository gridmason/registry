/**
 * Publisher records + prefix-registration API (FR-2, FR-10; SPEC §2, §5, §9).
 *
 * - `POST /v1/publishers`      — register an OIDC-bound publisher and claim its
 *                                namespace prefix (the shipped schema models one
 *                                prefix per publisher, so registration is the
 *                                claim). Requires a bearer token from an
 *                                allowlisted issuer.
 * - `GET  /v1/publishers/:id`  — read a publisher record (source-qualified).
 * - `GET  /v1/prefixes/:prefix`— read who owns a prefix on this registry.
 *
 * Reads are anonymous (registry outputs are public, SPEC §8); only registration
 * requires identity. Every register/claim mutation emits an `AuditEvent` (FR-12).
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import { emitAuditEvent } from '../audit/index.js';
import { extractBearerToken, type OidcVerifier } from '../auth/oidc.js';
import {
  toPrefixOwnershipResponse,
  toPublisherResponse,
} from '../publisher/presenter.js';
import type { PublisherStore } from '../publisher/store.js';
import {
  composeOidcIdentity,
  isPublisherTier,
  validatePrefix,
  type PublisherTier,
} from '../publisher/types.js';
import { sendError } from './errors.js';
import { OIDC_REJECTION_RESPONSES } from './oidc-rejection.js';

interface PublisherPluginOptions extends FastifyPluginOptions {
  store: PublisherStore;
  registryId: string;
  verifier: OidcVerifier;
}

interface RegisterBody {
  prefix?: unknown;
  tier?: unknown;
}

export async function publisherRoutes(
  app: FastifyInstance,
  options: PublisherPluginOptions,
): Promise<void> {
  const { store, registryId, verifier } = options;

  app.post('/v1/publishers', async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      return sendError(reply, 401, 'missing_token', 'a bearer token is required');
    }

    const verified = await verifier.verify(token);
    if (!verified.ok) {
      // Record the denied attempt (FR-12). The token failed verification, so its
      // claims are untrusted — the event names only the reason, not an identity.
      emitAuditEvent('anonymous', 'publisher.register.denied', `register:${verified.reason}`);
      const { status, code, message } = OIDC_REJECTION_RESPONSES[verified.reason];
      return sendError(reply, status, code, message);
    }
    const { issuer, subject } = verified.identity;

    const body = (request.body ?? {}) as RegisterBody;
    if (typeof body.prefix !== 'string') {
      return sendError(reply, 400, 'invalid_request', 'prefix is required and must be a string');
    }
    const prefixViolation = validatePrefix(body.prefix);
    if (prefixViolation) {
      return sendError(
        reply,
        400,
        'invalid_prefix',
        `prefix is invalid (${prefixViolation})`,
      );
    }

    let tier: PublisherTier = 'community';
    if (body.tier !== undefined) {
      if (!isPublisherTier(body.tier)) {
        return sendError(
          reply,
          400,
          'invalid_request',
          'tier must be one of community, verified, operator',
        );
      }
      tier = body.tier;
    }

    const result = await store.register({ issuer, subject, prefix: body.prefix, tier });
    if (!result.ok) {
      return result.conflict === 'prefix'
        ? sendError(
            reply,
            409,
            'prefix_taken',
            `prefix "${body.prefix}" is already claimed on this registry`,
          )
        : sendError(
            reply,
            409,
            'publisher_exists',
            'a publisher is already registered for this identity',
          );
    }

    const { record } = result;
    const actor = composeOidcIdentity(issuer, subject);
    // The single call performs two state transitions (SPEC §5): it creates the
    // identity and claims the namespace prefix. Audit both (FR-12).
    emitAuditEvent(actor, 'publisher.register', record.id);
    emitAuditEvent(actor, 'prefix.claim', `${registryId}/${record.prefix}`);

    reply.code(201);
    return toPublisherResponse(record, registryId);
  });

  app.get<{ Params: { id: string } }>('/v1/publishers/:id', async (request, reply) => {
    const record = await store.findById(request.params.id);
    if (!record) {
      return sendError(reply, 404, 'not_found', 'no publisher with that id');
    }
    return toPublisherResponse(record, registryId);
  });

  app.get<{ Params: { prefix: string } }>(
    '/v1/prefixes/:prefix',
    async (request, reply) => {
      const record = await store.findByPrefix(request.params.prefix);
      if (!record) {
        return sendError(reply, 404, 'not_found', 'no publisher owns that prefix on this registry');
      }
      return toPrefixOwnershipResponse(record, registryId);
    },
  );
}
