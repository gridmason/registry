/**
 * Trust-root rotation (FR-9; SPEC §2, §4.4) — `scripts/rotate-root.ts`.
 *
 * The overlap document this script emits is what lets a registry rotate its
 * countersign root without a flag-day re-pin, so the bar is the host's own
 * decision: a host pinned to **either** the outgoing or the incoming root trusts the
 * document during the overlap, its `crossSig` verifies under the outgoing root, and
 * once the outgoing root is dropped a host still pinned only to it is refused
 * (fail-closed). We check all of that with the protocol's own host functions
 * (`parseTrustRoot`, `evaluateTrustRoot`) plus the strict JSON Schema (FR-5) — the
 * same gates `rotate-dry-run.ts` walks, locked in CI here.
 */
import { createPublicKey, verify } from 'node:crypto';
import { createRequire } from 'node:module';

import { Ajv, type ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';

import {
  canonicalize,
  evaluateTrustRoot,
  parseTrustRoot,
  type TrustRootDoc,
  type TrustRootPin,
} from '@gridmason/protocol';

import { loadConfig } from '../src/config/index.js';
import { loadCountersignIdentity } from '../src/countersign/index.js';
import { deriveCountersignRoot, generateTrustRootDoc } from '../scripts/trust-root-init.js';
import {
  deriveIncomingRoot,
  generateOverlapDoc,
  parseArgs,
  RotateRootError,
  signCrossSig,
} from '../scripts/rotate-root.js';
import { makeCountersignFixture } from './countersign/fixtures/envelope.js';

const require = createRequire(import.meta.url);
const trustRootSchema = require('@gridmason/protocol/schemas/trust-root.json');
const validateTrustRoot: ValidateFunction = new Ajv({
  strict: false,
  allErrors: true,
}).compile(trustRootSchema);

const REGISTRY_ID = 'registry.example';
const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A rotation setup: the outgoing identity + config, and the incoming key's cert/root. */
function rotationFixture() {
  const outgoingFixture = makeCountersignFixture();
  const incomingFixture = makeCountersignFixture();
  const config = loadConfig({
    REGISTRY_ID,
    OIDC_ISSUER_ALLOWLIST: 'https://issuer.example',
    COUNTERSIGN_PRIVATE_KEY: outgoingFixture.privateKeyPem,
    COUNTERSIGN_CERTIFICATE: outgoingFixture.certificatePem,
  });
  const outgoing = loadCountersignIdentity(config.countersign);
  if (outgoing === null) throw new Error('outgoing key failed to load');
  return { config, outgoing, outgoingFixture, incomingFixture };
}

function pin(root: string): TrustRootPin {
  return { registryId: REGISTRY_ID, root, channel: 'deploy-time' };
}

/** The host-side crossSig check: outgoing key's signature over the doc sans crossSig. */
function crossSigVerifies(doc: TrustRootDoc, outgoingSpkiDer: Uint8Array): boolean {
  if (doc.crossSig === undefined) return false;
  const { crossSig, ...withoutCrossSig } = doc;
  const key = createPublicKey({
    key: Buffer.from(outgoingSpkiDer),
    format: 'der',
    type: 'spki',
  });
  return verify(
    'sha256',
    canonicalize(withoutCrossSig),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(crossSig, 'base64'),
  );
}

describe('deriveIncomingRoot', () => {
  it('derives the pinnable fingerprint from the incoming certificate', () => {
    const incoming = makeCountersignFixture();
    const { root, publicKeySpkiDer } = deriveIncomingRoot(incoming.certificatePem);
    expect(root).toBe(deriveCountersignRoot(incoming.countersignRootSpki));
    expect(new Uint8Array(publicKeySpkiDer)).toEqual(new Uint8Array(incoming.countersignRootSpki));
  });

  it('rejects a certificate that is not valid PEM', () => {
    expect(() => deriveIncomingRoot('not a certificate')).toThrow(RotateRootError);
  });
});

describe('generateOverlapDoc', () => {
  it('lists both roots (outgoing first) and cross-signs with the outgoing key', () => {
    const { config, outgoing, outgoingFixture, incomingFixture } = rotationFixture();
    const incoming = deriveIncomingRoot(incomingFixture.certificatePem);

    const doc = generateOverlapDoc({
      config,
      outgoing,
      incomingRoot: incoming.root,
      now: NOW,
      validityDays: 365,
    });

    const outgoingRoot = deriveCountersignRoot(outgoingFixture.countersignRootSpki);
    expect(doc.countersignRoots).toEqual([outgoingRoot, incoming.root]);
    expect(doc.registryId).toBe(REGISTRY_ID);
    expect(doc.issuerAllowlist).toEqual(['https://issuer.example']);
    expect(doc.notBefore).toBe(NOW);
    expect(doc.notAfter).toBe(NOW + 365 * DAY_MS);
    expect(doc.crossSig).toBeTypeOf('string');

    // The two acceptance gates: the protocol parser and the strict JSON Schema.
    expect(parseTrustRoot(doc).ok).toBe(true);
    expect(validateTrustRoot(doc)).toBe(true);
  });

  it('produces a crossSig that verifies under the outgoing root and no other', () => {
    const { config, outgoing, outgoingFixture, incomingFixture } = rotationFixture();
    const incoming = deriveIncomingRoot(incomingFixture.certificatePem);
    const doc = generateOverlapDoc({
      config,
      outgoing,
      incomingRoot: incoming.root,
      now: NOW,
      validityDays: 365,
    });

    expect(crossSigVerifies(doc, outgoingFixture.countersignRootSpki)).toBe(true);
    // Not the incoming key — only the outgoing root authorizes the overlap (SPEC §4.4).
    expect(crossSigVerifies(doc, incomingFixture.countersignRootSpki)).toBe(false);
    // A tampered document breaks the signature.
    expect(
      crossSigVerifies(
        { ...doc, registryId: 'evil.example' },
        outgoingFixture.countersignRootSpki,
      ),
    ).toBe(false);
  });

  it('carries out-of-band publisher-CA roots and log keys through the rotation', () => {
    const { config, outgoing, incomingFixture } = rotationFixture();
    const incoming = deriveIncomingRoot(incomingFixture.certificatePem);
    const doc = generateOverlapDoc({
      config,
      outgoing,
      incomingRoot: incoming.root,
      now: NOW,
      validityDays: 90,
      extra: { publisherCARoots: ['ca-root-1'], logPublicKeys: ['log-key-1'] },
    });
    expect(doc.publisherCARoots).toEqual(['ca-root-1']);
    expect(doc.logPublicKeys).toEqual(['log-key-1']);
    expect(validateTrustRoot(doc)).toBe(true);
  });

  it('refuses to rotate a root onto itself', () => {
    const { config, outgoing, outgoingFixture } = rotationFixture();
    const sameRoot = deriveCountersignRoot(outgoingFixture.countersignRootSpki);
    expect(() =>
      generateOverlapDoc({ config, outgoing, incomingRoot: sameRoot, now: NOW, validityDays: 365 }),
    ).toThrow(RotateRootError);
  });
});

describe('signCrossSig', () => {
  it('signs the canonical bytes of the document as delivered (crossSig stripped)', () => {
    const { config, outgoing, outgoingFixture, incomingFixture } = rotationFixture();
    const incoming = deriveIncomingRoot(incomingFixture.certificatePem);
    const doc = generateOverlapDoc({
      config,
      outgoing,
      incomingRoot: incoming.root,
      now: NOW,
      validityDays: 365,
    });
    // The signed preimage is the document with its own crossSig removed (SPEC §4.4).
    // ECDSA is randomized, so the bytes differ from the doc's field each time — the
    // check is that a fresh signature over the stripped document still verifies.
    const { crossSig: _dropped, ...stripped } = doc;
    const fresh = signCrossSig(stripped, outgoing);
    expect(crossSigVerifies({ ...stripped, crossSig: fresh }, outgoingFixture.countersignRootSpki)).toBe(
      true,
    );
  });
});

describe('overlap-window rotation — host acceptance (the acceptance criterion)', () => {
  it('a host pinned to EITHER root trusts the overlap document; a stranger is refused', () => {
    const { config, outgoing, outgoingFixture, incomingFixture } = rotationFixture();
    const incoming = deriveIncomingRoot(incomingFixture.certificatePem);
    const outgoingRoot = deriveCountersignRoot(outgoingFixture.countersignRootSpki);

    const doc = generateOverlapDoc({
      config,
      outgoing,
      incomingRoot: incoming.root,
      now: NOW,
      validityDays: 365,
    });
    // Deliver it as a host would — untrusted JSON narrowed back through the parser.
    const delivered = parseTrustRoot(JSON.parse(JSON.stringify(doc)) as unknown);
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;

    const viaOutgoing = evaluateTrustRoot(delivered.doc, [pin(outgoingRoot)], NOW);
    expect(viaOutgoing.ok).toBe(true);
    expect(viaOutgoing.overlap).toBe(true);
    expect(viaOutgoing.matchedRoot).toBe(outgoingRoot);

    const viaIncoming = evaluateTrustRoot(delivered.doc, [pin(incoming.root)], NOW);
    expect(viaIncoming.ok).toBe(true);
    expect(viaIncoming.overlap).toBe(true);
    expect(viaIncoming.matchedRoot).toBe(incoming.root);

    const stranger = evaluateTrustRoot(delivered.doc, [pin('sha256:deadbeef')], NOW);
    expect(stranger.ok).toBe(false);
    expect(stranger.code).toBe('unpinned');
  });

  it('once the outgoing root is dropped, a host still pinned only to it is refused', () => {
    const { outgoingFixture, incomingFixture } = rotationFixture();
    const outgoingRoot = deriveCountersignRoot(outgoingFixture.countersignRootSpki);
    const incomingRoot = deriveCountersignRoot(incomingFixture.countersignRootSpki);

    // The drop step is install-time generation under the INCOMING key (single root).
    const droppedConfig = loadConfig({
      REGISTRY_ID,
      COUNTERSIGN_PRIVATE_KEY: incomingFixture.privateKeyPem,
      COUNTERSIGN_CERTIFICATE: incomingFixture.certificatePem,
    });
    const dropped = generateTrustRootDoc(droppedConfig, NOW, 365);
    expect(dropped.countersignRoots).toEqual([incomingRoot]);

    const stillOld = evaluateTrustRoot(dropped, [pin(outgoingRoot)], NOW);
    expect(stillOld.ok).toBe(false);
    expect(stillOld.code).toBe('unpinned');

    const nowNew = evaluateTrustRoot(dropped, [pin(incomingRoot)], NOW);
    expect(nowNew.ok).toBe(true);
    expect(nowNew.overlap).toBe(false);
  });
});

describe('parseArgs', () => {
  it('requires --incoming-cert', () => {
    expect(() => parseArgs([])).toThrow(RotateRootError);
    expect(() => parseArgs(['--out', 'x.json'])).toThrow(RotateRootError);
  });

  it('defaults out, validity, and flags when only --incoming-cert is given', () => {
    expect(parseArgs(['--incoming-cert', 'new.crt'])).toEqual({
      incomingCert: 'new.crt',
      out: 'trust-root.overlap.json',
      stdout: false,
      force: false,
      validityDays: 365,
    });
  });

  it('honors --out, --stdout, --force, and --validity-days', () => {
    const opts = parseArgs([
      '--incoming-cert', 'new.crt',
      '--out', 'overlap.json',
      '--stdout', '--force',
      '--validity-days', '730',
    ]);
    expect(opts).toEqual({
      incomingCert: 'new.crt',
      out: 'overlap.json',
      stdout: true,
      force: true,
      validityDays: 730,
    });
  });

  it('rejects a non-positive-integer validity window', () => {
    expect(() => parseArgs(['--incoming-cert', 'new.crt', '--validity-days', '0'])).toThrow(
      RotateRootError,
    );
    expect(() => parseArgs(['--incoming-cert', 'new.crt', '--validity-days', 'abc'])).toThrow(
      RotateRootError,
    );
  });
});
