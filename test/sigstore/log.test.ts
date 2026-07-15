/**
 * In-process transparency log (#10): the RFC 6962 log emits entries whose
 * inclusion proofs verify against `@gridmason/protocol`'s `verifyLogInclusion` —
 * the same check a host runs on a Rekor entry. If this log's Merkle math or
 * checkpoint format ever drift from the verifier, this fails here, not in a host.
 */
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyLogInclusion } from '@gridmason/protocol';

import {
  encodeLogPublicKey,
  InMemoryTransparencyLog,
  loadStableMemoryKey,
  MemoryLogKeyError,
} from '../../src/sigstore/log.js';

function leaf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A fresh Ed25519 private key as base64 PKCS#8 DER (the TRANSPARENCY_LOG_MEMORY_KEY shape). */
function ed25519DerB64(): string {
  return (generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64');
}

function rawKeyB64(log: InMemoryTransparencyLog): string {
  return Buffer.from(log.publicKey().key).toString('base64');
}

function appendInput(text: string) {
  return {
    body: leaf(text),
    releaseHash: `sha2-256:${'00'.repeat(32)}`,
    signatureB64: '',
    certificateB64: '',
  };
}

describe('InMemoryTransparencyLog', () => {
  it('every appended entry verifies against the pinned log key', async () => {
    const log = new InMemoryTransparencyLog('registry.test');
    const key = log.publicKey();

    const entries = [];
    for (const text of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      entries.push((await log.append(appendInput(text))).entry);
    }

    for (const entry of entries) {
      const verdict = await verifyLogInclusion(entry, key);
      expect(verdict.reason).toBe('ok');
    }
  });

  it('assigns increasing leaf indices and a growing tree', async () => {
    const log = new InMemoryTransparencyLog('registry.test');
    const first = (await log.append(appendInput('one'))).entry;
    const second = (await log.append(appendInput('two'))).entry;
    expect(first.index).toBe(0);
    expect(second.index).toBe(1);
    expect(second.inclusionProof.treeSize).toBe(2);
  });

  it('refuses an entry checked against a different log key', async () => {
    const log = new InMemoryTransparencyLog('registry.test');
    const other = new InMemoryTransparencyLog('registry.test');
    const entry = (await log.append(appendInput('solo'))).entry;
    // A different log's checkpoint key must not accept this entry's checkpoint.
    const verdict = await verifyLogInclusion(entry, other.publicKey());
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('checkpoint-key-mismatch');
  });

  it('detects a tampered leaf body', async () => {
    const log = new InMemoryTransparencyLog('registry.test');
    const { entry } = await log.append(appendInput('genuine'));
    const tampered = { ...entry, canonicalBody: Buffer.from(leaf('forged')).toString('base64') };
    const verdict = await verifyLogInclusion(tampered, log.publicKey());
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('inclusion-proof-invalid');
  });
});

describe('InMemoryTransparencyLog — stable key (#61)', () => {
  it('a stable key survives a restart: an entry logged before still verifies after', async () => {
    const der = ed25519DerB64();

    // Boot 1: log a release.
    const before = new InMemoryTransparencyLog('registry.test', loadStableMemoryKey(der));
    const entry = (await before.append(appendInput('pre-restart'))).entry;

    // Boot 2: a fresh instance built from the SAME key (a restart) — same key...
    const after = new InMemoryTransparencyLog('registry.test', loadStableMemoryKey(der));
    expect(rawKeyB64(after)).toBe(rawKeyB64(before));
    expect(after.publicKey().name).toBe(before.publicKey().name);

    // ...so the pre-restart entry still verifies against the post-restart key.
    const verdict = await verifyLogInclusion(entry, after.publicKey());
    expect(verdict.reason).toBe('ok');
  });

  it('an ephemeral log (no key) gets a different public key every construction', () => {
    expect(rawKeyB64(new InMemoryTransparencyLog('registry.test'))).not.toBe(
      rawKeyB64(new InMemoryTransparencyLog('registry.test')),
    );
  });

  it('loadStableMemoryKey rejects garbage and non-Ed25519 keys, accepts a valid one', () => {
    expect(() => loadStableMemoryKey('not-valid-der!!!')).toThrow(MemoryLogKeyError);
    const rsa = (generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64');
    expect(() => loadStableMemoryKey(rsa)).toThrow(/Ed25519/);
    expect(loadStableMemoryKey(ed25519DerB64()).asymmetricKeyType).toBe('ed25519');
  });

  it('encodeLogPublicKey emits ed25519:<name>:<base64 raw 32-byte key>', () => {
    const log = new InMemoryTransparencyLog('registry.example.com', loadStableMemoryKey(ed25519DerB64()));
    const encoded = encodeLogPublicKey(log.publicKey());
    const prefix = 'ed25519:registry.example.com:';
    expect(encoded.startsWith(prefix)).toBe(true);
    expect(Buffer.from(encoded.slice(prefix.length), 'base64').length).toBe(32);
  });
});
