import { describe, expect, it } from 'vitest';

import { extractBearerToken, verifyOidcToken } from '../../src/auth/oidc.js';

/** Build an unsigned JWT (the signature is not verified this phase). */
function makeToken(claims: Record<string, unknown>): string {
  const encode = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.sig`;
}

const ISSUER = 'https://accounts.example.com';
const ALLOWLIST = [ISSUER];
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

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

describe('verifyOidcToken', () => {
  it('accepts a token from an allowlisted issuer and lifts iss + sub', () => {
    const token = makeToken({ iss: ISSUER, sub: 'user-1', exp: FUTURE });
    const result = verifyOidcToken(token, ALLOWLIST);
    expect(result).toEqual({ ok: true, identity: { issuer: ISSUER, subject: 'user-1' } });
  });

  it('refuses a token from a non-allowlisted issuer', () => {
    const token = makeToken({ iss: 'https://evil.example', sub: 'user-1', exp: FUTURE });
    expect(verifyOidcToken(token, ALLOWLIST)).toEqual({
      ok: false,
      reason: 'issuer-not-allowed',
    });
  });

  it('refuses an expired token', () => {
    const token = makeToken({ iss: ISSUER, sub: 'user-1', exp: 1000 });
    expect(verifyOidcToken(token, ALLOWLIST)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a token missing iss or sub', () => {
    expect(verifyOidcToken(makeToken({ sub: 'user-1' }), ALLOWLIST)).toEqual({
      ok: false,
      reason: 'missing-claims',
    });
    expect(verifyOidcToken(makeToken({ iss: ISSUER }), ALLOWLIST)).toEqual({
      ok: false,
      reason: 'missing-claims',
    });
  });

  it('refuses a structurally malformed token', () => {
    expect(verifyOidcToken('not-a-jwt', ALLOWLIST)).toEqual({
      ok: false,
      reason: 'malformed-token',
    });
    expect(verifyOidcToken('a.b', ALLOWLIST)).toEqual({
      ok: false,
      reason: 'malformed-token',
    });
  });

  it('refuses every token when the allowlist is empty (fail closed)', () => {
    const token = makeToken({ iss: ISSUER, sub: 'user-1', exp: FUTURE });
    expect(verifyOidcToken(token, [])).toEqual({ ok: false, reason: 'issuer-not-allowed' });
  });

  it('accepts a token with no exp claim', () => {
    const token = makeToken({ iss: ISSUER, sub: 'user-1' });
    expect(verifyOidcToken(token, ALLOWLIST)).toEqual({
      ok: true,
      identity: { issuer: ISSUER, subject: 'user-1' },
    });
  });
});
