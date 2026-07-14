import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOidcVerifier, extractBearerToken } from '../../src/auth/oidc.js';
import { startFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.js';

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

describe('extractBearerToken', () => {
  it('pulls the token from a Bearer header, case-insensitively', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('returns null for a missing or non-bearer header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});

describe('createOidcVerifier', () => {
  let issuer: FakeIssuer;

  beforeAll(async () => {
    issuer = await startFakeIssuer();
  });

  afterAll(async () => {
    await issuer.close();
  });

  /** A verifier trusting the fake issuer, with the given audience requirement. */
  function verifier(audience?: string) {
    return createOidcVerifier({ issuerAllowlist: [issuer.issuer], audience });
  }

  it('accepts a validly signed token and lifts iss + sub', async () => {
    const token = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
    await expect(verifier().verify(token)).resolves.toEqual({
      ok: true,
      identity: { issuer: issuer.issuer, subject: 'user-1' },
    });
  });

  it('rejects an expired token', async () => {
    const token = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: PAST });
    await expect(verifier().verify(token)).resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token not yet valid (nbf in the future)', async () => {
    const token = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', nbf: FUTURE });
    await expect(verifier().verify(token)).resolves.toEqual({ ok: false, reason: 'not-yet-valid' });
  });

  it('rejects a token signed by a key not in the issuer JWKS (wrong key)', async () => {
    const token = await issuer.signWithWrongKey({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
    await expect(verifier().verify(token)).resolves.toEqual({
      ok: false,
      reason: 'invalid-signature',
    });
  });

  it('rejects a token from a non-allowlisted issuer before any network call', async () => {
    const token = await issuer.sign({ iss: 'https://evil.example', sub: 'user-1', exp: FUTURE });
    await expect(verifier().verify(token)).resolves.toEqual({
      ok: false,
      reason: 'issuer-not-allowed',
    });
  });

  it('rejects an unsecured alg:none token (alg-confusion guard)', async () => {
    const token = issuer.unsecured({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
    await expect(verifier().verify(token)).resolves.toEqual({
      ok: false,
      reason: 'invalid-signature',
    });
  });

  it('rejects an HS256 token even when the secret is the issuer id (alg-confusion guard)', async () => {
    const token = await issuer.signHs256({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE }, issuer.issuer);
    await expect(verifier().verify(token)).resolves.toEqual({
      ok: false,
      reason: 'invalid-signature',
    });
  });

  it('enforces the audience when configured', async () => {
    const good = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE, aud: 'registry.test' });
    await expect(verifier('registry.test').verify(good)).resolves.toEqual({
      ok: true,
      identity: { issuer: issuer.issuer, subject: 'user-1' },
    });

    const wrong = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE, aud: 'other' });
    await expect(verifier('registry.test').verify(wrong)).resolves.toEqual({
      ok: false,
      reason: 'audience-mismatch',
    });
  });

  it('rejects a token missing sub', async () => {
    const token = await issuer.sign({ iss: issuer.issuer, exp: FUTURE });
    await expect(verifier().verify(token)).resolves.toEqual({ ok: false, reason: 'missing-claims' });
  });

  it('rejects a structurally malformed token', async () => {
    await expect(verifier().verify('not-a-jwt')).resolves.toEqual({
      ok: false,
      reason: 'malformed-token',
    });
  });

  it('refuses every token when the allowlist is empty (fail closed)', async () => {
    const token = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
    const empty = createOidcVerifier({ issuerAllowlist: [] });
    await expect(empty.verify(token)).resolves.toEqual({ ok: false, reason: 'issuer-not-allowed' });
  });

  it('fails closed when discovery is unreachable', async () => {
    issuer.failDiscovery(500);
    try {
      // A fresh verifier so no prior discovery result is cached.
      const v = createOidcVerifier({ issuerAllowlist: [issuer.issuer] });
      const token = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
      await expect(v.verify(token)).resolves.toEqual({
        ok: false,
        reason: 'verification-unavailable',
      });
    } finally {
      issuer.failDiscovery(null);
    }
  });

  it('fails closed when the JWKS endpoint is unreachable', async () => {
    issuer.failJwks(500);
    try {
      const v = createOidcVerifier({ issuerAllowlist: [issuer.issuer] });
      const token = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
      await expect(v.verify(token)).resolves.toEqual({
        ok: false,
        reason: 'verification-unavailable',
      });
    } finally {
      issuer.failJwks(null);
    }
  });

  // --- Auth/API hardening (issue #29) ---

  it('rejects a token over the size cap before any decode (item 3)', async () => {
    // Over 8 KiB: refused on length alone, never parsed.
    const oversized = 'a'.repeat(8_193);
    await expect(verifier().verify(oversized)).resolves.toEqual({
      ok: false,
      reason: 'token-too-large',
    });
  });

  it('honours a configured max token length (item 3)', async () => {
    const v = createOidcVerifier({ issuerAllowlist: [issuer.issuer], maxTokenLength: 10 });
    await expect(v.verify('12345678901')).resolves.toEqual({
      ok: false,
      reason: 'token-too-large',
    });
  });

  it('does not follow a redirect on discovery — fails closed (item 1)', async () => {
    // A compromised issuer 302s discovery at the JWKS endpoint (stand-in for an
    // internal address). The redirect must not be followed.
    issuer.redirectDiscovery(`${issuer.issuer}/jwks`);
    try {
      const v = createOidcVerifier({ issuerAllowlist: [issuer.issuer] });
      const token = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
      const jwksBefore = issuer.jwksHits();
      await expect(v.verify(token)).resolves.toEqual({
        ok: false,
        reason: 'verification-unavailable',
      });
      // The redirect target was never fetched.
      expect(issuer.jwksHits()).toBe(jwksBefore);
    } finally {
      issuer.redirectDiscovery(null);
    }
  });

  it('does not follow a redirect on the JWKS fetch — fails closed (item 1)', async () => {
    issuer.redirectJwks(`${issuer.issuer}/.well-known/openid-configuration`);
    try {
      const v = createOidcVerifier({ issuerAllowlist: [issuer.issuer] });
      const token = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
      const discoveryBefore = issuer.discoveryHits();
      await expect(v.verify(token)).resolves.toEqual({
        ok: false,
        reason: 'verification-unavailable',
      });
      // Discovery was hit once to resolve jwks_uri; the JWKS redirect back to
      // discovery was not followed.
      expect(issuer.discoveryHits()).toBe(discoveryBefore + 1);
    } finally {
      issuer.redirectJwks(null);
    }
  });

  it('backs off per-issuer after an unreachable verification (item 2)', async () => {
    issuer.failDiscovery(500);
    let clock = 1_000;
    try {
      const v = createOidcVerifier({
        issuerAllowlist: [issuer.issuer],
        failureBackoffBaseMs: 5_000,
        now: () => clock,
      });
      const token = await issuer.sign({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });
      const before = issuer.discoveryHits();

      await expect(v.verify(token)).resolves.toEqual({
        ok: false,
        reason: 'verification-unavailable',
      });
      expect(issuer.discoveryHits()).toBe(before + 1);

      // Inside the backoff window: short-circuits without touching discovery.
      await expect(v.verify(token)).resolves.toEqual({
        ok: false,
        reason: 'verification-unavailable',
      });
      expect(issuer.discoveryHits()).toBe(before + 1);

      // Past the window: discovery is retried.
      clock = 7_000;
      await expect(v.verify(token)).resolves.toEqual({
        ok: false,
        reason: 'verification-unavailable',
      });
      expect(issuer.discoveryHits()).toBe(before + 2);
    } finally {
      issuer.failDiscovery(null);
    }
  });

  it('caches a recent failure so a repeated bad token is refused without re-verifying (item 2)', async () => {
    // cooldown 0 lets jose refetch the JWKS on the unknown kid, so a repeat that
    // was NOT cached would generate fresh JWKS traffic.
    const v = createOidcVerifier({ issuerAllowlist: [issuer.issuer], jwksCooldownMs: 0 });
    const token = await issuer.signWithUnknownKid({ iss: issuer.issuer, sub: 'user-1', exp: FUTURE });

    await expect(v.verify(token)).resolves.toEqual({ ok: false, reason: 'invalid-signature' });
    const afterFirst = issuer.jwksHits();
    expect(afterFirst).toBeGreaterThan(0);

    // The identical token is served from the failure cache: zero JWKS traffic.
    await expect(v.verify(token)).resolves.toEqual({ ok: false, reason: 'invalid-signature' });
    expect(issuer.jwksHits()).toBe(afterFirst);
  });
});
