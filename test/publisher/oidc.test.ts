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
});
