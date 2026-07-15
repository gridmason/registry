/**
 * Trust-root rotation — publish an overlap document (FR-9; SPEC §2, §4.4).
 *
 * Rotation is **manual this phase** (SCOPE cut): this script performs the one
 * cryptographic step of an overlap-window rotation — cross-signing — and leaves the
 * process steps (generate the new key, publish the document in the transparency log,
 * run the overlap window, switch signing, drop the old root) to the operator, who
 * walks them from `docs/self-host/rotation.md`. There is no automated rotation
 * service.
 *
 * To rotate its countersign root without a flag-day re-pin, a registry publishes an
 * **overlap document** that lists **both** the outgoing and incoming countersign
 * roots and carries a `crossSig` — the outgoing root's signature over the document
 * (SPEC §4.4). During the overlap window a host pinned to either root still trusts
 * the document, and the cross-signature is the proof the outgoing root authorized
 * the incoming one, so a host may safely add the incoming root to its pins. This
 * script builds that document:
 *
 *   1. Reads the **outgoing** countersign key from the same config the running
 *      service reads (`COUNTERSIGN_PRIVATE_KEY` / `COUNTERSIGN_CERTIFICATE`), reusing
 *      {@link loadCountersignIdentity} — the outgoing key is the cross-signer, so it
 *      must be the key the instance currently countersigns with.
 *   2. Derives the **incoming** root from a certificate the operator generated
 *      offline for the new key (`--incoming-cert`) — its public half only; the
 *      incoming private key never touches this script and stays offline (SPEC §4a).
 *   3. Emits a `@gridmason/protocol` {@link TrustRootDoc} listing both roots and
 *      signs its RFC-8785 canonical bytes with the outgoing key to fill `crossSig`
 *      (the ratified contract: the preimage is the document with its own `crossSig`
 *      field removed, and hosts accept the signature under any pinned root key).
 *
 * Like {@link import('./trust-root-init.js')}, it is a docs/ops helper run via `tsx`
 * (wired to `npm run rotate:root`); it is not part of the running service and is not
 * shipped in the container image.
 *
 * Usage:
 *   # env carries the OUTGOING key (the same env the service runs with):
 *   npm run rotate:root -- --incoming-cert new-countersign.crt   # write ./trust-root.overlap.json
 *   npm run rotate:root -- --incoming-cert new-countersign.crt --out overlap.json
 *   npm run rotate:root -- --incoming-cert new-countersign.crt --stdout
 *   npm run rotate:root -- --incoming-cert new-countersign.crt --validity-days 730
 */
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { canonicalize, parseTrustRoot, type TrustRootDoc } from '@gridmason/protocol';

import { loadConfig, type Config } from '../src/config/index.js';
import {
  loadCountersignIdentity,
  type CountersignIdentity,
} from '../src/countersign/index.js';
import {
  buildTrustRootDoc,
  deriveCountersignRoot,
  type ExtraRoots,
} from './trust-root-init.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default validity window: one year, matching the install recipe (`-days 365`). */
const DEFAULT_VALIDITY_DAYS = 365;

/** Why {@link generateOverlapDoc} (or the CLI around it) could not produce a document. */
export class RotateRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RotateRootError';
  }
}

/** The incoming root derived from an operator-supplied certificate. */
export interface IncomingRoot {
  /** The `sha256:` fingerprint hosts pin as the new countersign root. */
  readonly root: string;
  /** SPKI DER of the incoming certificate's public key. */
  readonly publicKeySpkiDer: Uint8Array;
}

/**
 * Derive the incoming countersign root from the new key's certificate (PEM). Only
 * the public half is read — the incoming private key stays offline (SPEC §4a). The
 * incoming key must be P-256, the only curve the countersign path and the verify
 * lib accept, so a mismatched key is refused here rather than producing a root the
 * instance could never load as its own signing key later.
 */
export function deriveIncomingRoot(certificatePem: string): IncomingRoot {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch (err) {
    throw new RotateRootError(
      `incoming certificate is not a valid PEM X.509 certificate: ${(err as Error).message}`,
    );
  }
  const publicKey = certificate.publicKey;
  if (publicKey.asymmetricKeyType !== 'ec') {
    throw new RotateRootError('incoming certificate key must be an EC (P-256) key');
  }
  if (publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new RotateRootError(
      `incoming certificate key must use curve P-256 (prime256v1), got ` +
        `${publicKey.asymmetricKeyDetails?.namedCurve ?? 'unknown'}`,
    );
  }
  const publicKeySpkiDer = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));
  return { root: deriveCountersignRoot(publicKeySpkiDer), publicKeySpkiDer };
}

/**
 * Compute the `crossSig` for an overlap document: the outgoing key's signature over
 * the document's RFC-8785 canonical bytes. Per the SPEC §4.4 ratified contract the
 * signed preimage is the document with its own `crossSig` field removed — this
 * function is called before that field is added, so `docWithoutCrossSig` *is* the
 * preimage. The signature is ECDSA P-256 / SHA-256 in IEEE-P1363 form, base64 — the
 * same form the countersignature carries — accepted by a host under any pinned root.
 */
export function signCrossSig(
  docWithoutCrossSig: TrustRootDoc,
  outgoing: CountersignIdentity,
): string {
  const preimage = canonicalize(docWithoutCrossSig);
  return Buffer.from(outgoing.sign(preimage)).toString('base64');
}

/** The inputs {@link generateOverlapDoc} needs — key material plus config/CLI values. */
export interface OverlapInput {
  readonly config: Config;
  /** The outgoing countersign identity — the cross-signer (its private key signs). */
  readonly outgoing: CountersignIdentity;
  /** The incoming root the new key certifies (from {@link deriveIncomingRoot}). */
  readonly incomingRoot: string;
  /** Validity-window start, epoch ms. */
  readonly now: number;
  /** Validity-window length in days; `notAfter = now + validityDays`. */
  readonly validityDays: number;
  /** Optional out-of-band roots, mirrored from install-time generation. */
  readonly extra?: ExtraRoots;
}

/**
 * Build the overlap {@link TrustRootDoc}: both roots listed (outgoing first, the
 * cross-signer; incoming second, the successor), cross-signed by the outgoing key.
 * The other trust anchors (issuers, log keys, publisher-CA roots) carry over from
 * the same config the install-time document was generated from, so a rotation
 * changes only the countersign root. Throws {@link RotateRootError} if the incoming
 * root equals the outgoing one (nothing to rotate) or if the produced document does
 * not narrow back through the protocol's own {@link parseTrustRoot} — the exact gate
 * a host runs.
 */
export function generateOverlapDoc(input: OverlapInput): TrustRootDoc {
  const outgoingRoot = deriveCountersignRoot(input.outgoing.publicKeySpkiDer);
  if (outgoingRoot === input.incomingRoot) {
    throw new RotateRootError(
      'the incoming root is identical to the outgoing root — nothing to rotate. ' +
        'Generate a fresh countersign key for the incoming root.',
    );
  }

  const base = buildTrustRootDoc({
    registryId: input.config.registryId,
    // Overlap: list BOTH roots so a host pinned to either still matches (SPEC §4.4).
    countersignRoots: [outgoingRoot, input.incomingRoot],
    issuerAllowlist: input.config.oidc.issuerAllowlist,
    publisherCARoots: input.extra?.publisherCARoots ?? [],
    logPublicKeys: input.extra?.logPublicKeys ?? [],
    notBefore: input.now,
    notAfter: input.now + input.validityDays * DAY_MS,
  });

  const doc: TrustRootDoc = { ...base, crossSig: signCrossSig(base, input.outgoing) };

  const parsed = parseTrustRoot(doc);
  if (!parsed.ok) {
    // Unreachable barring a builder bug — surfaced loudly rather than writing a
    // document a host would reject.
    throw new RotateRootError(
      `generated overlap document failed protocol validation: ${parsed.reason}`,
    );
  }
  return parsed.doc;
}

/** Split a comma-separated env value into a trimmed, non-empty list (absent → []). */
function readList(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

// --- CLI --------------------------------------------------------------------

interface CliOptions {
  readonly incomingCert: string;
  readonly out: string;
  readonly stdout: boolean;
  readonly force: boolean;
  readonly validityDays: number;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const flagValue = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const incomingCert = flagValue('--incoming-cert');
  if (incomingCert === undefined || incomingCert === '') {
    throw new RotateRootError(
      '--incoming-cert <path> is required: the certificate of the new (incoming) ' +
        'countersign key to rotate to.',
    );
  }

  const validityRaw = flagValue('--validity-days');
  let validityDays = DEFAULT_VALIDITY_DAYS;
  if (validityRaw !== undefined) {
    const parsed = Number(validityRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new RotateRootError(
        `--validity-days must be a positive integer, got "${validityRaw}"`,
      );
    }
    validityDays = parsed;
  }

  return {
    incomingCert,
    out: flagValue('--out') ?? 'trust-root.overlap.json',
    stdout: argv.includes('--stdout'),
    force: argv.includes('--force'),
    validityDays,
  };
}

function isEntrypoint(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  const options = parseArgs(argv);
  const config = loadConfig(env);

  const outgoing = loadCountersignIdentity(config.countersign);
  if (outgoing === null) {
    throw new RotateRootError(
      'no countersign key is configured — the outgoing key must be present to ' +
        'cross-sign the overlap document. Set COUNTERSIGN_PRIVATE_KEY and ' +
        'COUNTERSIGN_CERTIFICATE to the OUTGOING key (the one the instance currently ' +
        'countersigns with).',
    );
  }

  const incoming = deriveIncomingRoot(readFileSync(options.incomingCert, 'utf8'));

  const doc = generateOverlapDoc({
    config,
    outgoing,
    incomingRoot: incoming.root,
    now: Date.now(),
    validityDays: options.validityDays,
    extra: {
      publisherCARoots: readList(env.TRUST_ROOT_PUBLISHER_CA_ROOTS),
      logPublicKeys: readList(env.TRUST_ROOT_LOG_PUBLIC_KEYS),
    },
  });
  const json = `${JSON.stringify(doc, null, 2)}\n`;

  if (options.stdout) {
    process.stdout.write(json);
    return 0;
  }

  if (existsSync(options.out) && !options.force) {
    process.stderr.write(
      `refusing to overwrite existing ${options.out} (pass --force to replace it)\n`,
    );
    return 1;
  }

  writeFileSync(options.out, json);
  const [outgoingRoot, incomingRoot] = doc.countersignRoots;
  process.stdout.write(`wrote ${options.out} for registry "${doc.registryId}"\n`);
  process.stdout.write(`  outgoing root (cross-signer): ${outgoingRoot}\n`);
  process.stdout.write(`  incoming root (successor):    ${incomingRoot}\n`);
  process.stdout.write(
    `  valid ${new Date(doc.notBefore).toISOString()} → ${new Date(doc.notAfter).toISOString()}\n`,
  );
  process.stdout.write(
    '  next: publish this document in the transparency log and alongside the instance, ' +
      'and hand the incoming root to host operators to add as a pin. See ' +
      'docs/self-host/rotation.md.\n',
  );
  return 0;
}

if (isEntrypoint()) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
