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
import { createHash } from 'node:crypto';

import {
  createRemoteJWKSet,
  customFetch,
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
  | 'token-too-large'
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
  /**
   * Reject a bearer token longer than this many characters before any decode
   * (SPEC hardening: an oversized credential is refused cheaply, never parsed).
   */
  readonly maxTokenLength?: number;
  /**
   * Per-issuer failure backoff (item 2): after a verification that could not
   * reach the issuer (`verification-unavailable`), further verifications for
   * that issuer short-circuit as unavailable — without re-hitting discovery/JWKS
   * — until a cooldown elapses. The window starts at `failureBackoffBaseMs` and
   * doubles per consecutive failure up to `failureBackoffMaxMs`; any reachable
   * outcome (success or a definite token verdict) resets it.
   */
  readonly failureBackoffBaseMs?: number;
  readonly failureBackoffMaxMs?: number;
  /**
   * Small cache of recent *definite* verification failures, keyed by a hash of
   * the token, so a spammed identical bad token is refused without re-decoding
   * or re-verifying. Only stable verdicts are cached (never the transient
   * `verification-unavailable`, nor time-dependent `expired`/`not-yet-valid`).
   */
  readonly failureCacheTtlMs?: number;
  readonly failureCacheMaxEntries?: number;
  /** Clock source (ms). Injectable so tests can drive backoff/cache expiry. */
  readonly now?: () => number;
}

/** Verifies bearer tokens against their issuer's JWKS. Holds a per-issuer cache. */
export interface OidcVerifier {
  verify(token: string): Promise<OidcVerifyResult>;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 600_000; // 10 minutes
const DEFAULT_JWKS_COOLDOWN_MS = 30_000;
const DEFAULT_CLOCK_TOLERANCE_SEC = 30;
/** 8 KiB: a comfortable ceiling for a real OIDC token; anything larger is abuse. */
const DEFAULT_MAX_TOKEN_LENGTH = 8_192;
const DEFAULT_FAILURE_BACKOFF_BASE_MS = 1_000;
const DEFAULT_FAILURE_BACKOFF_MAX_MS = 30_000;
const DEFAULT_FAILURE_CACHE_TTL_MS = 60_000;
const DEFAULT_FAILURE_CACHE_MAX_ENTRIES = 1_000;

/**
 * Reasons cheap and stable enough to memoise for a token: the verdict depends
 * only on the (immutable) token bytes and config, so a spammed identical token
 * can be refused from cache. Deliberately excludes `verification-unavailable`
 * (transient) and `expired`/`not-yet-valid` (clock-dependent — must re-check).
 */
const CACHEABLE_FAILURES: ReadonlySet<OidcRejectionReason> = new Set([
  'token-too-large',
  'malformed-token',
  'missing-claims',
  'issuer-not-allowed',
  'audience-mismatch',
  'invalid-signature',
]);

/**
 * Fetch that refuses to follow HTTP redirects (`redirect: 'error'` rejects on
 * any 3xx). Used for OIDC discovery, and layered over jose's JWKS fetch, so a
 * compromised/misconfigured allowlisted issuer cannot bounce either request to
 * an internal address (e.g. cloud metadata). See {@link createOidcVerifier}.
 */
async function fetchNoRedirect(
  url: string,
  init: NonNullable<Parameters<typeof fetch>[1]>,
): Promise<Response> {
  return fetch(url, { ...init, redirect: 'error' });
}

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
  const maxTokenLength = options.maxTokenLength ?? DEFAULT_MAX_TOKEN_LENGTH;
  const backoffBaseMs = options.failureBackoffBaseMs ?? DEFAULT_FAILURE_BACKOFF_BASE_MS;
  const backoffMaxMs = options.failureBackoffMaxMs ?? DEFAULT_FAILURE_BACKOFF_MAX_MS;
  const failureCacheTtlMs = options.failureCacheTtlMs ?? DEFAULT_FAILURE_CACHE_TTL_MS;
  const failureCacheMaxEntries =
    options.failureCacheMaxEntries ?? DEFAULT_FAILURE_CACHE_MAX_ENTRIES;
  const now = options.now ?? Date.now;

  // Resolved JWKS resolvers, keyed by issuer. Populated on first successful
  // discovery; a failed discovery is not cached so the next attempt retries.
  const resolvers = new Map<string, JwksResolver>();
  const discovering = new Map<string, Promise<JwksResolver>>();

  // Per-issuer backoff state: how many consecutive unreachable verifications,
  // and the timestamp until which further attempts short-circuit (item 2).
  const backoff = new Map<string, { failures: number; openUntil: number }>();
  // Recent stable failures keyed by a token hash (item 2). Insertion-ordered so
  // eviction is a cheap FIFO once the bound is hit.
  const failureCache = new Map<string, { reason: OidcRejectionReason; expiresAt: number }>();

  function tokenKey(token: string): string {
    return createHash('sha256').update(token).digest('base64url');
  }

  /** Record a stable rejection for this token (bounded, FIFO-evicted) and return it. */
  function cacheFailure(key: string, reason: OidcRejectionReason): OidcVerifyResult {
    if (CACHEABLE_FAILURES.has(reason)) {
      if (failureCache.size >= failureCacheMaxEntries) {
        const oldest = failureCache.keys().next().value;
        if (oldest !== undefined) failureCache.delete(oldest);
      }
      failureCache.set(key, { reason, expiresAt: now() + failureCacheTtlMs });
    }
    return reject(reason);
  }

  /** True while `issuer` is inside its failure-backoff window. */
  function isBackedOff(issuer: string): boolean {
    const state = backoff.get(issuer);
    return state !== undefined && state.openUntil > now();
  }

  /** An issuer we could not reach: grow the backoff window (capped). */
  function recordUnreachable(issuer: string): void {
    const state = backoff.get(issuer) ?? { failures: 0, openUntil: 0 };
    state.failures += 1;
    const delay = Math.min(backoffBaseMs * 2 ** (state.failures - 1), backoffMaxMs);
    state.openUntil = now() + delay;
    backoff.set(issuer, state);
  }

  /** The issuer answered (any verdict): clear its backoff. */
  function clearBackoff(issuer: string): void {
    backoff.delete(issuer);
  }

  async function discoverJwksUri(issuer: string): Promise<string> {
    // OIDC Discovery 1.0 §4: the configuration document is the issuer with
    // `/.well-known/openid-configuration` appended (issuer never ends in `/`).
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), discoveryTimeoutMs);
    let response: Response;
    try {
      // No redirects: a `Location` bounce from a compromised issuer must not be
      // followed to an internal address (item 1).
      response = await fetchNoRedirect(url, {
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
        // jose already fetches the JWKS with `redirect: 'manual'` (a redirect
        // yields a non-200 opaque response it rejects); we override to
        // `redirect: 'error'` so the no-redirect policy is explicit and owned
        // here rather than depending on that internal default (item 1).
        [customFetch]: fetchNoRedirect,
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
      // Refuse an oversized credential before spending anything decoding it
      // (item 3). Not cached — the check is already O(1) on the length.
      if (token.length > maxTokenLength) return reject('token-too-large');

      // A recently-seen identical bad token is refused straight from cache,
      // sparing the decode/verify (and any network) it would otherwise drive.
      const key = tokenKey(token);
      const cached = failureCache.get(key);
      if (cached) {
        if (cached.expiresAt > now()) return reject(cached.reason);
        failureCache.delete(key);
      }

      // Read `iss` without trusting it, only to enforce the allowlist and pick
      // the discovery endpoint. Nothing here is believed until the signature
      // over this same payload verifies below.
      let unverified: JWTPayload;
      try {
        unverified = decodeJwt(token);
      } catch {
        return cacheFailure(key, 'malformed-token');
      }
      const iss = unverified.iss;
      if (typeof iss !== 'string' || iss === '') return cacheFailure(key, 'missing-claims');
      if (!issuerAllowlist.includes(iss)) return cacheFailure(key, 'issuer-not-allowed');

      // The issuer is currently unreachable and inside its backoff window: fail
      // closed immediately, without re-hitting discovery/JWKS (item 2).
      if (isBackedOff(iss)) return reject('verification-unavailable');

      let jwks: JwksResolver;
      try {
        jwks = await resolveJwks(iss);
      } catch {
        recordUnreachable(iss);
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
        const result = mapVerifyError(err);
        if (!result.ok && result.reason === 'verification-unavailable') {
          // Couldn't reach the JWKS to decide: grow the backoff.
          recordUnreachable(iss);
          return result;
        }
        // A definite verdict means the issuer answered: clear any backoff and
        // memoise stable rejections.
        clearBackoff(iss);
        return result.ok ? result : cacheFailure(key, result.reason);
      }

      clearBackoff(iss);
      const sub = payload.sub;
      if (typeof sub !== 'string' || sub === '') return cacheFailure(key, 'missing-claims');
      return { ok: true, identity: { issuer: iss, subject: sub } };
    },
  };
}
