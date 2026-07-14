/**
 * Operator authentication for the SCOPE-minimal Ops API (SPEC §6, §8).
 *
 * The ops surface ships no console: an operator authenticates with a bearer token
 * that must (1) verify against an allowlisted OIDC issuer (SPEC §2) and (2) name
 * an identity in this registry's configured operator set (`OPS_OPERATOR_IDENTITIES`,
 * the same config-listed pattern as the reviewer roster). Every ops route that
 * mutates or reads privileged state authenticates the same way, so the check lives
 * here once and both the revocation endpoints (#14) and the audit-query endpoint
 * (#15) call it — a single wire contract for "not an operator".
 *
 * On failure the response is already sent and the denial audited (`ops.denied`);
 * the caller returns the provided `body`. On success the verified {@link OidcIdentity}
 * is returned for the caller to compose into the audit actor.
 */
import type { FastifyReply } from 'fastify';

import { emitAuditEvent } from '../audit/index.js';
import { extractBearerToken, type OidcIdentity, type OidcVerifier } from '../auth/oidc.js';
import { composeOidcIdentity } from '../publisher/types.js';
import { sendError } from './errors.js';
import { OIDC_REJECTION_RESPONSES } from './oidc-rejection.js';

/** A resolved operator, or a response already sent (the caller returns its body). */
export type OperatorAuth =
  | { readonly ok: true; readonly identity: OidcIdentity }
  | { readonly ok: false; readonly body: unknown };

/**
 * Authenticate a bearer token and authorise it as an operator. On failure the
 * response is already sent (and the denial audited); the caller returns `body`.
 *
 * @param request  the incoming request (only its authorization header is read)
 * @param reply    the reply to send an error through on failure
 * @param verifier the OIDC verifier (issuer allowlist + audience)
 * @param operators the configured operator identity set
 */
export async function authenticateOperator(
  request: { headers: { authorization?: string } },
  reply: FastifyReply,
  verifier: OidcVerifier,
  operators: ReadonlySet<string>,
): Promise<OperatorAuth> {
  const token = extractBearerToken(request.headers.authorization);
  if (!token) {
    return { ok: false, body: sendError(reply, 401, 'missing_token', 'a bearer token is required') };
  }
  const verified = await verifier.verify(token);
  if (!verified.ok) {
    // The token failed verification, so its claims are untrusted — name only the reason.
    emitAuditEvent('anonymous', 'ops.denied', `ops:${verified.reason}`);
    const { status, code, message } = OIDC_REJECTION_RESPONSES[verified.reason];
    return { ok: false, body: sendError(reply, status, code, message) };
  }
  const identity = verified.identity;
  const operatorId = composeOidcIdentity(identity.issuer, identity.subject);
  if (!operators.has(operatorId)) {
    emitAuditEvent(operatorId, 'ops.denied', 'ops:not-an-operator');
    return {
      ok: false,
      body: sendError(
        reply,
        403,
        'not_an_operator',
        'this identity is not on the registry operator set',
      ),
    };
  }
  return { ok: true, identity };
}
