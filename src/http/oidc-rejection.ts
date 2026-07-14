/**
 * The HTTP response (status + stable machine `code` + human message) for each
 * {@link OidcRejectionReason}. Shared by every route that authenticates a bearer
 * token (publisher registration, publish intake) so a token failure maps to the
 * exact same wire contract regardless of which endpoint saw it.
 *
 * The mapping is deliberately lossy in one place: `token-too-large` is reported
 * identically to `malformed-token` (same `invalid_token` code and message) so an
 * oversized credential is not a probing oracle that distinguishes "too big" from
 * "malformed". `verification-unavailable` is a `503`, not a `401`: the registry
 * could not reach the issuer to decide, so the caller should retry rather than
 * treat the token as bad.
 */
import type { OidcRejectionReason } from '../auth/oidc.js';

export interface OidcRejectionResponse {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export const OIDC_REJECTION_RESPONSES: Record<
  OidcRejectionReason,
  OidcRejectionResponse
> = {
  'missing-token': { status: 401, code: 'missing_token', message: 'a bearer token is required' },
  'token-too-large': { status: 401, code: 'invalid_token', message: 'the token could not be validated' },
  'malformed-token': { status: 401, code: 'invalid_token', message: 'the token could not be validated' },
  'missing-claims': { status: 401, code: 'invalid_token', message: 'the token could not be validated' },
  expired: { status: 401, code: 'token_expired', message: 'the token has expired' },
  'not-yet-valid': { status: 401, code: 'token_not_yet_valid', message: 'the token is not yet valid' },
  'issuer-not-allowed': {
    status: 403,
    code: 'issuer_not_allowed',
    message: "the token issuer is not on this registry's allowlist",
  },
  'audience-mismatch': {
    status: 403,
    code: 'audience_not_allowed',
    message: 'the token audience does not match this registry',
  },
  'invalid-signature': {
    status: 401,
    code: 'invalid_token',
    message: 'the token signature could not be verified against the issuer',
  },
  'verification-unavailable': {
    status: 503,
    code: 'verification_unavailable',
    message: 'the token issuer could not be reached to verify the token',
  },
};
