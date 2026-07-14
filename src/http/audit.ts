/**
 * Audit-log query API (FR-12; SPEC §10, §8 Ops API).
 *
 * `GET /v1/ops/audit` — **operator-only**. Reads back the audit trail every state
 * transition writes (publish, review, sign, revoke, kill, …), so an operator or
 * auditor can answer "what happened to this subject / who did this action / what
 * changed in this window". This is the read half of FR-12: the emission side is
 * complete only if the events can be retrieved.
 *
 * Filters (all optional, AND-combined): `subject`, `action`, `since`, `until`
 * (ISO-8601 instants), with keyset pagination via `limit` + `before` (an event id;
 * results are newest-first, so page forward by passing the last id seen). The
 * endpoint is gated on the same operator set as the revocation ops endpoints (#14).
 *
 * Reading the audit log is itself a read surface, not a state transition, so a
 * query emits **no** audit event (consistent with serving/resolution, SPEC §10) —
 * only auth denials are audited (`ops.denied`), via the shared operator-auth seam.
 */
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';

import type { AuditQuery, AuditQueryStore } from '../audit/query.js';
import type { OidcVerifier } from '../auth/oidc.js';
import { sendError } from './errors.js';
import { authenticateOperator } from './operator-auth.js';

interface AuditPluginOptions extends FastifyPluginOptions {
  store: AuditQueryStore;
  verifier: OidcVerifier;
  /** The configured operator set, in `composeOidcIdentity` composite form. */
  operatorIdentities: readonly string[];
}

interface AuditQueryString {
  subject?: string;
  action?: string;
  since?: string;
  until?: string;
  before?: string;
  limit?: string;
}

/**
 * Parse a query string into an {@link AuditQuery}, or an error message describing
 * the first malformed parameter. Timestamps must be ISO-8601; `before`/`limit`
 * must be non-negative integers.
 */
function parseQuery(
  raw: AuditQueryString,
): { readonly ok: true; readonly query: AuditQuery } | { readonly ok: false; readonly message: string } {
  const query: {
    subject?: string;
    action?: string;
    since?: Date;
    until?: Date;
    before?: number;
    limit?: number;
  } = {};

  if (raw.subject !== undefined && raw.subject !== '') query.subject = raw.subject;
  if (raw.action !== undefined && raw.action !== '') query.action = raw.action;

  for (const key of ['since', 'until'] as const) {
    const value = raw[key];
    if (value === undefined || value === '') continue;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, message: `${key} must be an ISO-8601 timestamp` };
    }
    query[key] = parsed;
  }

  for (const key of ['before', 'limit'] as const) {
    const value = raw[key];
    if (value === undefined || value === '') continue;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { ok: false, message: `${key} must be a non-negative integer` };
    }
    query[key] = parsed;
  }

  return { ok: true, query };
}

export function auditRoutes(app: FastifyInstance, options: AuditPluginOptions): void {
  const { store, verifier } = options;
  const operators = new Set(options.operatorIdentities);

  app.get<{ Querystring: AuditQueryString }>(
    '/v1/ops/audit',
    async (request, reply: FastifyReply): Promise<unknown> => {
      const auth = await authenticateOperator(request, reply, verifier, operators);
      if (!auth.ok) return auth.body;

      const parsed = parseQuery(request.query);
      if (!parsed.ok) {
        return sendError(reply, 400, 'invalid_request', parsed.message);
      }

      const page = await store.query(parsed.query);
      return {
        events: page.events.map((event) => ({
          id: event.id,
          actor: event.actor,
          action: event.action,
          subject: event.subject,
          at: event.at.toISOString(),
        })),
        nextBefore: page.nextBefore,
      };
    },
  );
}
