/**
 * Trust-root generation at install (FR-9; SPEC §2, §4.4) — `scripts/trust-root-init.ts`.
 *
 * The document this script emits is the one a host bootstraps trust from, so the
 * bar is that it is a real `@gridmason/protocol` `TrustRootDoc`: it narrows back
 * through the protocol's own `parseTrustRoot` and validates against the shipped
 * JSON Schema (FR-5, the strict wire gate). The countersign root it carries must be
 * the pinnable SHA-256 fingerprint of the configured countersign certificate — the
 * same key the running service signs with.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { Ajv, type ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';

import { parseTrustRoot } from '@gridmason/protocol';

import { loadConfig } from '../src/config/index.js';
import {
  buildTrustRootDoc,
  deriveCountersignRoot,
  generateTrustRootDoc,
  parseArgs,
  TrustRootInitError,
} from '../scripts/trust-root-init.js';
import { makeCountersignFixture } from './countersign/fixtures/envelope.js';

// The shipped JSON Schema is the strict wire gate a host uses (FR-5); a document
// this script writes must validate against it. ajv is how upstream validates.
const require = createRequire(import.meta.url);
const trustRootSchema = require('@gridmason/protocol/schemas/trust-root.json');
const validateTrustRoot: ValidateFunction = new Ajv({
  strict: false,
  allErrors: true,
}).compile(trustRootSchema);

const DAY_MS = 24 * 60 * 60 * 1000;

/** A config whose countersign key is the fixture's self-signed key. */
function configWith(env: Record<string, string>) {
  const fixture = makeCountersignFixture();
  return {
    config: loadConfig({
      COUNTERSIGN_PRIVATE_KEY: fixture.privateKeyPem,
      COUNTERSIGN_CERTIFICATE: fixture.certificatePem,
      ...env,
    }),
    fixture,
  };
}

describe('deriveCountersignRoot', () => {
  it('is a stable sha256: fingerprint of the SPKI', () => {
    const spki = new Uint8Array([1, 2, 3, 4]);
    const expected = `sha256:${createHash('sha256').update(spki).digest('hex')}`;
    expect(deriveCountersignRoot(spki)).toBe(expected);
    expect(deriveCountersignRoot(spki)).toBe(deriveCountersignRoot(spki));
  });
});

describe('buildTrustRootDoc', () => {
  const base = {
    registryId: 'registry.example',
    countersignRoots: ['sha256:aa'],
    issuerAllowlist: ['https://issuer.example'],
    logPublicKeys: [],
    notBefore: 1_000,
    notAfter: 2_000,
  };

  it('omits publisherCARoots when none are supplied (keyless OIDC path)', () => {
    const doc = buildTrustRootDoc({ ...base, publisherCARoots: [] });
    expect(doc).not.toHaveProperty('publisherCARoots');
    expect(doc.formatVersion).toBe('1.0');
    expect(validateTrustRoot(doc)).toBe(true);
  });

  it('includes publisherCARoots when supplied (issued-cert path)', () => {
    const doc = buildTrustRootDoc({ ...base, publisherCARoots: ['ca-root-1'] });
    expect(doc.publisherCARoots).toEqual(['ca-root-1']);
    expect(validateTrustRoot(doc)).toBe(true);
  });
});

describe('generateTrustRootDoc', () => {
  it('throws when no countersign key is configured', () => {
    const config = loadConfig({ REGISTRY_ID: 'registry.example' });
    expect(() => generateTrustRootDoc(config, Date.now(), 365)).toThrow(TrustRootInitError);
  });

  it('emits a valid document anchored on the configured countersign key', () => {
    const { config, fixture } = configWith({
      REGISTRY_ID: 'registry.example',
      OIDC_ISSUER_ALLOWLIST: 'https://a.example,https://b.example',
    });
    const now = 1_700_000_000_000;
    const doc = generateTrustRootDoc(config, now, 365);

    const expectedRoot = deriveCountersignRoot(fixture.countersignRootSpki);
    expect(doc.registryId).toBe('registry.example');
    expect(doc.countersignRoots).toEqual([expectedRoot]);
    expect(doc.issuerAllowlist).toEqual(['https://a.example', 'https://b.example']);
    expect(doc.logPublicKeys).toEqual([]);
    expect(doc).not.toHaveProperty('publisherCARoots');
    expect(doc.notBefore).toBe(now);
    expect(doc.notAfter).toBe(now + 365 * DAY_MS);

    // The two acceptance gates: the protocol parser and the strict JSON Schema.
    expect(parseTrustRoot(doc).ok).toBe(true);
    expect(validateTrustRoot(doc)).toBe(true);
  });

  it('carries out-of-band publisher-CA roots and log keys when supplied', () => {
    const { config } = configWith({ REGISTRY_ID: 'registry.example' });
    const doc = generateTrustRootDoc(config, Date.now(), 90, {
      publisherCARoots: ['ca-root-1'],
      logPublicKeys: ['log-key-1'],
    });
    expect(doc.publisherCARoots).toEqual(['ca-root-1']);
    expect(doc.logPublicKeys).toEqual(['log-key-1']);
    expect(validateTrustRoot(doc)).toBe(true);
    expect(parseTrustRoot(doc).ok).toBe(true);
  });

  it('is trusted by a host that pins the emitted countersign root', () => {
    const { config, fixture } = configWith({ REGISTRY_ID: 'registry.example' });
    const doc = generateTrustRootDoc(config, Date.now(), 30);
    // The fingerprint is independently derivable from the key material — the
    // property that lets a host pin it verbatim (SPEC §4.4).
    expect(doc.countersignRoots[0]).toBe(deriveCountersignRoot(fixture.countersignRootSpki));
  });
});

describe('parseArgs', () => {
  it('defaults to trust-root.json, one-year validity, no stdout', () => {
    expect(parseArgs([])).toEqual({
      out: 'trust-root.json',
      stdout: false,
      force: false,
      validityDays: 365,
    });
  });

  it('honors --out, --stdout, --force, and --validity-days', () => {
    const opts = parseArgs(['--out', 'roots.json', '--stdout', '--force', '--validity-days', '730']);
    expect(opts).toEqual({ out: 'roots.json', stdout: true, force: true, validityDays: 730 });
  });

  it('rejects a non-positive-integer validity window', () => {
    expect(() => parseArgs(['--validity-days', '0'])).toThrow(TrustRootInitError);
    expect(() => parseArgs(['--validity-days', 'abc'])).toThrow(TrustRootInitError);
  });
});
