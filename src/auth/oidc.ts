/**
 * OIDC identity binding for publisher registration (SPEC §2).
 *
 * A publisher registers by presenting a bearer token from an OIDC issuer. The
 * **issuer is the trust anchor**: each registry configures an explicit issuer
 * allowlist, and the record captures the token's `iss` and `sub` claims so every
 * downstream output names exactly which identity vouched for a registration.
 *
 * SCOPE (Phase B, GW-D19 cut): this module extracts and validates the claims and
 * enforces the issuer allowlist, but does **not** cryptographically verify the
 * token signature against the issuer's JWKS. Full keyless verification (Fulcio /
 * issuer JWKS) arrives with the signing + countersign work and the
 * `@gridmason/protocol` verify lib. Until then this binding is trust-on-config,
 * not trust-on-crypto: DO NOT treat a registration as cryptographically attested
 * before that lands. The allowlist check below is the mandatory, load-bearing
 * gate and is enforced unconditionally.
 */

/** The identity claims lifted from an OIDC token. */
export interface OidcIdentity {
  /** The `iss` claim — the trust anchor, checked against the allowlist. */
  readonly issuer: string;
  /** The `sub` claim — the subject, unique within the issuer. */
  readonly subject: string;
}

/** Why a token was refused. Callers switch on the code, not a message. */
export type OidcRejectionReason =
  | 'missing-token'
  | 'malformed-token'
  | 'missing-claims'
  | 'expired'
  | 'issuer-not-allowed';

/** Outcome of {@link verifyOidcToken}: an identity, or a typed rejection. */
export type OidcVerifyResult =
  | { readonly ok: true; readonly identity: OidcIdentity }
  | { readonly ok: false; readonly reason: OidcRejectionReason };

/**
 * Pull the token out of an `Authorization: Bearer <token>` header. Returns
 * `null` when the header is absent or not a well-formed bearer credential; the
 * scheme match is case-insensitive per RFC 7235.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1]?.trim();
  return token ? token : null;
}

/** The subset of JWT claims we read. */
interface JwtClaims {
  readonly iss?: unknown;
  readonly sub?: unknown;
  readonly exp?: unknown;
}

/** Decode a JWT payload segment without verifying the signature. */
function decodeClaims(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as JwtClaims;
  } catch {
    return null;
  }
}

/**
 * Verify a bearer token far enough to bind a publisher identity: decode the
 * claims, require `iss` and `sub`, reject an expired token, and enforce the
 * issuer allowlist. See the module note on the signature-verification cut.
 *
 * @param token      the raw bearer token (see {@link extractBearerToken})
 * @param allowlist  trusted issuer URLs; a token from any other issuer is refused
 * @param now        clock for the `exp` check (injectable for tests)
 */
export function verifyOidcToken(
  token: string,
  allowlist: readonly string[],
  now: Date = new Date(),
): OidcVerifyResult {
  const claims = decodeClaims(token);
  if (!claims) return { ok: false, reason: 'malformed-token' };

  const { iss, sub, exp } = claims;
  if (typeof iss !== 'string' || iss === '' || typeof sub !== 'string' || sub === '') {
    return { ok: false, reason: 'missing-claims' };
  }

  if (exp !== undefined) {
    if (typeof exp !== 'number' || !Number.isFinite(exp)) {
      return { ok: false, reason: 'missing-claims' };
    }
    // `exp` is seconds since the epoch (RFC 7519).
    if (exp * 1000 <= now.getTime()) return { ok: false, reason: 'expired' };
  }

  if (!allowlist.includes(iss)) return { ok: false, reason: 'issuer-not-allowed' };

  return { ok: true, identity: { issuer: iss, subject: sub } };
}
