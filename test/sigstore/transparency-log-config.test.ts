/**
 * Transparency-log configuration + key exposure (#61): the `memory` driver takes
 * a stable Ed25519 key via `TRANSPARENCY_LOG_MEMORY_KEY`, a garbage value fails
 * boot loudly, the active key is derivable for the boot line + `trust-root:init`,
 * and the boot warning distinguishes a stable key from an ephemeral one.
 */
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { collectBootWarnings, loadConfig } from '../../src/config/index.js';
import {
  activeStableLogPublicKey,
  createTransparencyLog,
  InMemoryTransparencyLog,
  MemoryLogKeyError,
  RekorTransparencyLog,
} from '../../src/sigstore/index.js';
import { resolveLogPublicKeys } from '../../scripts/trust-root-init.js';

function ed25519DerB64(): string {
  return (generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64');
}

describe('createTransparencyLog (#61)', () => {
  it('builds a memory log from a stable key whose public key is derived from it', () => {
    const der = ed25519DerB64();
    const config = loadConfig({ REGISTRY_ID: 'registry.test', TRANSPARENCY_LOG_MEMORY_KEY: der });
    const log = createTransparencyLog(config.transparencyLog);
    expect(log).toBeInstanceOf(InMemoryTransparencyLog);
    const active = activeStableLogPublicKey(config.transparencyLog);
    expect(active).not.toBeNull();
    // The running log's key equals the independently-derived active key.
    expect(Buffer.from((log as InMemoryTransparencyLog).publicKey().key).toString('base64')).toBe(
      Buffer.from(active!.key).toString('base64'),
    );
  });

  it('fails boot loudly on a garbage stable key (never a silent ephemeral fallback)', () => {
    const config = loadConfig({ REGISTRY_ID: 'registry.test', TRANSPARENCY_LOG_MEMORY_KEY: 'not-a-key' });
    expect(() => createTransparencyLog(config.transparencyLog)).toThrow(MemoryLogKeyError);
  });

  it('builds an ephemeral memory log when no key is set, and a Rekor client in rekor mode', () => {
    const mem = loadConfig({ REGISTRY_ID: 'registry.test' });
    expect(createTransparencyLog(mem.transparencyLog)).toBeInstanceOf(InMemoryTransparencyLog);
    const rekor = loadConfig({ REGISTRY_ID: 'registry.test', TRANSPARENCY_LOG_DRIVER: 'rekor' });
    expect(createTransparencyLog(rekor.transparencyLog)).toBeInstanceOf(RekorTransparencyLog);
  });
});

describe('activeStableLogPublicKey (#61)', () => {
  it('derives the pinnable key for a stable memory log, null otherwise', () => {
    const stable = loadConfig({ REGISTRY_ID: 'registry.test', TRANSPARENCY_LOG_MEMORY_KEY: ed25519DerB64() });
    const active = activeStableLogPublicKey(stable.transparencyLog);
    expect(active?.name).toBe('registry.test');
    expect(active && active.key.length).toBe(32);

    // Ephemeral memory + rekor have no registry-derived pinnable key.
    expect(activeStableLogPublicKey(loadConfig({ REGISTRY_ID: 'r' }).transparencyLog)).toBeNull();
    expect(
      activeStableLogPublicKey(loadConfig({ REGISTRY_ID: 'r', TRANSPARENCY_LOG_DRIVER: 'rekor' }).transparencyLog),
    ).toBeNull();
  });
});

describe('resolveLogPublicKeys — trust-root:init population (#61)', () => {
  it('publishes the stable memory key first, then operator-supplied keys, deduped', () => {
    const der = ed25519DerB64();
    const config = loadConfig({ REGISTRY_ID: 'registry.test', TRANSPARENCY_LOG_MEMORY_KEY: der });
    const keys = resolveLogPublicKeys(config, { TRUST_ROOT_LOG_PUBLIC_KEYS: 'ed25519:rekor-key' } as NodeJS.ProcessEnv);
    expect(keys).toHaveLength(2);
    expect(keys[0]!.startsWith('ed25519:registry.test:')).toBe(true);
    expect(keys[1]).toBe('ed25519:rekor-key');
  });

  it('is empty for an ephemeral memory log with no operator keys', () => {
    const config = loadConfig({ REGISTRY_ID: 'registry.test' });
    expect(resolveLogPublicKeys(config, {} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('passes through operator keys in rekor mode (registry derives none)', () => {
    const config = loadConfig({ REGISTRY_ID: 'registry.test', TRANSPARENCY_LOG_DRIVER: 'rekor' });
    expect(
      resolveLogPublicKeys(config, { TRUST_ROOT_LOG_PUBLIC_KEYS: 'ed25519:rekor-key' } as NodeJS.ProcessEnv),
    ).toEqual(['ed25519:rekor-key']);
  });
});

describe('collectBootWarnings — memory key stability (#61)', () => {
  it('flags a stable key as STABLE and an ephemeral one as EPHEMERAL', () => {
    const stable = collectBootWarnings(loadConfig({ REGISTRY_ID: 'r', TRANSPARENCY_LOG_MEMORY_KEY: ed25519DerB64() }));
    expect(stable.some((w) => w.includes('STABLE'))).toBe(true);
    const ephemeral = collectBootWarnings(loadConfig({ REGISTRY_ID: 'r' }));
    expect(ephemeral.some((w) => w.includes('EPHEMERAL'))).toBe(true);
  });
});
