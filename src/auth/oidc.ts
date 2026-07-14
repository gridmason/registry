/**
 * OIDC identity binding for publisher registration (SPEC §2).
 *
 * A publisher registers by presenting a bearer token from an OIDC issuer. The
 * **issuer is the trust anchor**: each registry configures an explicit issuer
 * allowlist, and the record captures the token's `iss` and `sub` claims so every
 * downstream output names exactly which identity vouched for a registration.
 *
 * The binding is trust-on-crypto, not trust-on-config: the token's signature is
 * verified against the issuer's published keys (OIDC discovery → `jwks_uri`)
 * before any claim is believed. The order is load-bearing — the issuer allowlist
 * is checked *first* (cheap, and it gates which discovery endpoint we ever
 * contact), then discovery + JWKS signature verification, then claim extraction.
 * Only asymmetric algorithms are accepted: `alg: none` and the `HS*` family are
 * refused so a leaked/guessed symmetric secret or an unsecured token can never
 * impersonate an allowlisted issuer (alg-confusion guard). Discovery and JWKS
 * fetch failures fail closed.
 */
import {
  createRemoteJWKSet,
  decodeJwt,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
} from 'jose';

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
  | 'not-yet-valid'
  | 'issuer-not-allowed'
  | 'audience-mismatch'
  | 'invalid-signature'
  | 'verification-unavailable';

/** Outcome of {@link OidcVerifier.verify}: an identity, or a typed rejection. */
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

/**
 * Asymmetric signature algorithms we accept. `none` and the `HS*` family are
 * deliberately excluded: a token verified against an issuer's *public* JWKS must
 * be signed with the matching *private* key, so permitting a symmetric or
 * unsecured `alg` would open the classic alg-confusion bypass.
 */
const ASYMMETRIC_ALGORITHMS: readonly string[] = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];

/** Tunables for {@link createOidcVerifier}; every field has a sensible default. */
export interface OidcVerifierOptions {
  /** Trusted issuer URLs; a token from any other issuer is refused up front. */
  readonly issuerAllowlist: readonly string[];
  /**
   * Required `aud` claim. When set, a token whose audience does not include it
   * is refused; when unset, the audience is not checked.
   */
  readonly audience?: string;
  /** Permitted clock skew (seconds) for the `exp`/`nbf` checks. */
  readonly clockToleranceSec?: number;
  /** Abort an OIDC discovery request after this many milliseconds. */
  readonly discoveryTimeoutMs?: number;
  /** Max age (ms) a fetched JWKS is trusted before a forced refetch. */
  readonly jwksCacheMaxAgeMs?: number;
  /** Minimum interval (ms) between JWKS refetches triggered by an unknown key. */
  readonly jwksCooldownMs?: number;
}

/** Verifies bearer tokens against their issuer's JWKS. Holds a per-issuer cache. */
export interface OidcVerifier {
  verify(token: string): Promise<OidcVerifyResult>;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 600_000; // 10 minutes
const DEFAULT_JWKS_COOLDOWN_MS = 30_000;
const DEFAULT_CLOCK_TOLERANCE_SEC = 30;

/** A remote key resolver as returned by {@link createRemoteJWKSet}. */
type JwksResolver = ReturnType<typeof createRemoteJWKSet>;

/** Discovery failed (transport, non-200, or a spec-invalid document). */
class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

function reject(reason: OidcRejectionReason): OidcVerifyResult {
  return { ok: false, reason };
}

/**
 * Build a verifier bound to an issuer allowlist. Discovery results and the
 * per-issuer JWKS resolver are cached for the verifier's lifetime; `jose`'s
 * remote key set refreshes keys on its own (TTL + refetch on an unknown `kid`),
 * so issuer key rotation is handled without restarting the service.
 */
export function createOidcVerifier(options: OidcVerifierOptions): OidcVerifier {
  const issuerAllowlist = options.issuerAllowlist;
  const audience = options.audience;
  const clockTolerance = options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const cacheMaxAge = options.jwksCacheMaxAgeMs ?? DEFAULT_JWKS_CACHE_MAX_AGE_MS;
  const cooldownDuration = options.jwksCooldownMs ?? DEFAULT_JWKS_COOLDOWN_MS;

  // Resolved JWKS resolvers, keyed by issuer. Populated on first successful
  // discovery; a failed discovery is not cached so the next attempt retries.
  const resolvers = new Map<string, JwksResolver>();
  const discovering = new Map<string, Promise<JwksResolver>>();

  async function discoverJwksUri(issuer: string): Promise<string> {
    // OIDC Discovery 1.0 §4: the configuration document is the issuer with
    // `/.well-known/openid-configuration` appended (issuer never ends in `/`).
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), discoveryTimeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
    } catch (cause) {
      throw new DiscoveryError(`discovery request for ${issuer} failed: ${String(cause)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new DiscoveryError(`discovery for ${issuer} returned HTTP ${response.status}`);
    }
    let doc: unknown;
    try {
      doc = await response.json();
    } catch (cause) {
      throw new DiscoveryError(`discovery for ${issuer} was not JSON: ${String(cause)}`);
    }
    const record = doc as { issuer?: unknown; jwks_uri?: unknown };
    // The document MUST self-report the same issuer (OIDC Discovery §4.3); a
    // mismatch means the endpoint is lying about whose keys it serves.
    if (record.issuer !== issuer) {
      throw new DiscoveryError(`discovery for ${issuer} reports a different issuer`);
    }
    if (typeof record.jwks_uri !== 'string' || record.jwks_uri === '') {
      throw new DiscoveryError(`discovery for ${issuer} is missing jwks_uri`);
    }
    return record.jwks_uri;
  }

  function resolveJwks(issuer: string): Promise<JwksResolver> {
    const cached = resolvers.get(issuer);
    if (cached) return Promise.resolve(cached);
    const inFlight = discovering.get(issuer);
    if (inFlight) return inFlight;
    const promise = (async () => {
      const jwksUri = await discoverJwksUri(issuer);
      const resolver = createRemoteJWKSet(new URL(jwksUri), {
        cacheMaxAge,
        cooldownDuration,
        timeoutDuration: discoveryTimeoutMs,
      });
      resolvers.set(issuer, resolver);
      return resolver;
    })();
    discovering.set(issuer, promise);
    // Clear the in-flight slot once settled: a success is now in `resolvers`, a
    // failure must not be memoised so a transient outage can recover.
    promise.finally(() => discovering.delete(issuer)).catch(() => undefined);
    return promise;
  }

  function mapVerifyError(err: unknown): OidcVerifyResult {
    if (err instanceof joseErrors.JWTExpired) return reject('expired');
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      switch (err.claim) {
        case 'nbf':
          return reject('not-yet-valid');
        case 'aud':
          return reject('audience-mismatch');
        default:
          return reject('missing-claims');
      }
    }
    // Wrong key, tampered payload, `none`/`HS*`, or a `kid` absent from the JWKS:
    // in every case the token is not validly signed by the issuer.
    if (
      err instanceof joseErrors.JWSSignatureVerificationFailed ||
      err instanceof joseErrors.JOSEAlgNotAllowed ||
      err instanceof joseErrors.JWKSNoMatchingKey ||
      err instanceof joseErrors.JWKSMultipleMatchingKeys
    ) {
      return reject('invalid-signature');
    }
    if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
      return reject('malformed-token');
    }
    // JWKS timeouts and any other fault during key retrieval are infrastructure
    // failures, not a verdict on the token: fail closed as unavailable.
    return reject('verification-unavailable');
  }

  return {
    async verify(token: string): Promise<OidcVerifyResult> {
      // Read `iss` without trusting it, only to enforce the allowlist and pick
      // the discovery endpoint. Nothing here is believed until the signature
      // over this same payload verifies below.
      let unverified: JWTPayload;
      try {
        unverified = decodeJwt(token);
      } catch {
        return reject('malformed-token');
      }
      const iss = unverified.iss;
      if (typeof iss !== 'string' || iss === '') return reject('missing-claims');
      if (!issuerAllowlist.includes(iss)) return reject('issuer-not-allowed');

      let jwks: JwksResolver;
      try {
        jwks = await resolveJwks(iss);
      } catch {
        return reject('verification-unavailable');
      }

      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer: iss,
          ...(audience !== undefined ? { audience } : {}),
          algorithms: [...ASYMMETRIC_ALGORITHMS],
          clockTolerance,
        }));
      } catch (err) {
        return mapVerifyError(err);
      }

      const sub = payload.sub;
      if (typeof sub !== 'string' || sub === '') return reject('missing-claims');
      return { ok: true, identity: { issuer: iss, subject: sub } };
    },
  };
}
