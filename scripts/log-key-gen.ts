/**
 * Generate a stable signing key for the in-process (`memory`) transparency log
 * (#61) — the operator flow is: **gen → env → `trust-root:init` → hosts pin**.
 *
 * The `memory` driver otherwise generates a fresh key each boot, so restarts
 * orphan every previously countersigned release's inclusion proof and no host can
 * pin the checkpoint key. Generating one stable key and projecting it as
 * `TRANSPARENCY_LOG_MEMORY_KEY` fixes both: `trust-root:init` then publishes the
 * matching public key in `logPublicKeys`, and a host pins it as its `logPublicKey`.
 *
 * This is a **dev / e2e** affordance — the `memory` log is not durable and not
 * publicly anchored (a production instance sets `TRANSPARENCY_LOG_DRIVER=rekor`).
 * It is a docs/ops helper run via `tsx` (`npm run log-key:gen`), not part of the
 * running image.
 *
 * Usage:
 *   npm run log-key:gen            # prints the private key (set as the env) + the public key
 *   npm run log-key:gen -- --json  # machine-readable { privateKeyDerBase64, publicKeyRawBase64 }
 */
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** A freshly generated Ed25519 log key, both halves base64-encoded. */
export interface GeneratedLogKey {
  /** Base64 PKCS#8 DER private key — the `TRANSPARENCY_LOG_MEMORY_KEY` value. */
  readonly privateKeyDerBase64: string;
  /** Base64 of the raw 32-byte Ed25519 public key — the host's `logPublicKey.key`. */
  readonly publicKeyRawBase64: string;
}

/** Generate a fresh Ed25519 keypair and encode both halves the way #61 consumes them. */
export function generateLogKey(): GeneratedLogKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyDerBase64 = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64');
  // The raw 32-byte public key is the `x` coordinate of the Ed25519 JWK.
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (jwk.x === undefined) throw new Error('ed25519 public key JWK is missing its x coordinate');
  const publicKeyRawBase64 = Buffer.from(jwk.x, 'base64url').toString('base64');
  return { privateKeyDerBase64, publicKeyRawBase64 };
}

function isEntrypoint(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

export function main(argv: readonly string[]): number {
  const key = generateLogKey();
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(key)}\n`);
    return 0;
  }
  process.stdout.write(
    'Generated a stable Ed25519 key for the in-process (memory) transparency log.\n\n' +
      'Project the private key into the service (keep it out of version control):\n\n' +
      `  export TRANSPARENCY_LOG_MEMORY_KEY="${key.privateKeyDerBase64}"\n\n` +
      'Then `npm run trust-root:init` publishes the matching public key in the\n' +
      "trust-root document's logPublicKeys, and hosts pin it as their logPublicKey.\n" +
      'The public key (raw 32-byte Ed25519, base64) is:\n\n' +
      `  ${key.publicKeyRawBase64}\n\n` +
      'Dev/e2e only — the memory log is not durable or publicly anchored; a\n' +
      'production instance sets TRANSPARENCY_LOG_DRIVER=rekor instead.\n',
  );
  return 0;
}

if (isEntrypoint()) {
  process.exit(main(process.argv.slice(2)));
}
