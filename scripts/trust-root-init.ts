/**
 * Trust-root generation at install (FR-9; SPEC §2, §4.4).
 *
 * A self-hosted registry bootstraps host trust from a **pinned trust-root
 * document**: the signed statement of the roots a host must pin this instance
 * against — the countersign root that anchors its approval (`registrySig`)
 * signatures, the OIDC issuers (and optional publisher-CA roots) that anchor
 * authorship, and the transparency-log keys that anchor inclusion proofs. Hosts
 * never fetch this blind: they pin one of its `countersignRoots` out of band and
 * refuse a document no pin covers (SPEC §4.4). This script generates that
 * document once, at install, in the public `@gridmason/protocol` `TrustRootDoc`
 * format, from the instance's own configuration.
 *
 * It reads the same {@link loadConfig} env the service reads and reuses the
 * existing countersign key handling ({@link loadCountersignIdentity},
 * `src/countersign`) — it does not re-derive key material, so the root it emits is
 * exactly the one the running service countersigns with. The countersign root is
 * the SHA-256 fingerprint of the certificate's SubjectPublicKeyInfo — the stable,
 * operator-checkable identifier a host pins (an operator can reproduce it from the
 * cert with `openssl`, see `docs/self-host/install.md`).
 *
 * Rotation (publishing an overlap document that lists both the outgoing and
 * incoming roots with a `crossSig`) is **manual this phase** (SCOPE cut) and is
 * documented in the rotation runbook, not automated here — this script covers
 * generation-at-install only.
 *
 * It is a docs/ops helper run via `tsx` (wired to `npm run trust-root:init`); like
 * the policy renderer it is not part of the running service and is not shipped in
 * the container image.
 *
 * Usage:
 *   npm run trust-root:init                     # write ./trust-root.json
 *   npm run trust-root:init -- --out roots.json # write to a chosen path
 *   npm run trust-root:init -- --stdout         # print, write nothing
 *   npm run trust-root:init -- --validity-days 730
 */
import { existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseTrustRoot, type TrustRootDoc } from '@gridmason/protocol';

import { loadConfig, type Config } from '../src/config/index.js';
import { loadCountersignIdentity } from '../src/countersign/index.js';

/** Wire-format version this build authors; the protocol verify lib accepts `1.x`. */
const FORMAT_VERSION = '1.0';

/** Default validity window: one year, matching the self-signed cert recipe (`-days 365`). */
const DEFAULT_VALIDITY_DAYS = 365;

/**
 * Derive the countersign-root identifier a host pins: `sha256:<hex>` of the
 * certificate's DER SubjectPublicKeyInfo. Stable across restarts (it is a property
 * of the key, not the process) and independently reproducible by an operator from
 * the certificate — the property that lets a host pin verbatim (SPEC §4.4).
 */
export function deriveCountersignRoot(publicKeySpkiDer: Uint8Array): string {
  const digest = createHash('sha256').update(publicKeySpkiDer).digest('hex');
  return `sha256:${digest}`;
}

/** The inputs {@link buildTrustRootDoc} needs — everything sourced from config/CLI. */
export interface TrustRootInput {
  readonly registryId: string;
  /** The countersign-root identifier(s) hosts pin (SPEC §4.4). Non-empty. */
  readonly countersignRoots: readonly string[];
  /** OIDC issuer origins that anchor authorship (SPEC §4.2); may be empty. */
  readonly issuerAllowlist: readonly string[];
  /** Publisher-CA roots for the issued-cert authorship path (SPEC §4.4); omitted when empty. */
  readonly publisherCARoots: readonly string[];
  /** Transparency-log public keys hosts pin inclusion proofs against (SPEC §4.3); may be empty. */
  readonly logPublicKeys: readonly string[];
  /** Validity-window start, epoch ms. */
  readonly notBefore: number;
  /** Validity-window end, epoch ms; must be `>= notBefore`. */
  readonly notAfter: number;
}

/**
 * Build the {@link TrustRootDoc} for one instance. Pure — no I/O, no clock; the
 * caller supplies `notBefore`/`notAfter`. `publisherCARoots` is present only when
 * non-empty so the document round-trips under the schema's optional-field rules
 * (the keyless OIDC path omits it).
 */
export function buildTrustRootDoc(input: TrustRootInput): TrustRootDoc {
  const doc: TrustRootDoc = {
    formatVersion: FORMAT_VERSION,
    registryId: input.registryId,
    countersignRoots: [...input.countersignRoots],
    issuerAllowlist: [...input.issuerAllowlist],
    logPublicKeys: [...input.logPublicKeys],
    notBefore: input.notBefore,
    notAfter: input.notAfter,
  };
  if (input.publisherCARoots.length > 0) {
    return { ...doc, publisherCARoots: [...input.publisherCARoots] };
  }
  return doc;
}

/** Why {@link generateTrustRootDoc} could not produce a document. */
export class TrustRootInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustRootInitError';
  }
}

/** Optional roots supplied out of band, read from the environment by {@link main}. */
export interface ExtraRoots {
  /** Publisher-CA roots for the issued-cert authorship path (SPEC §4.4). */
  readonly publisherCARoots?: readonly string[];
  /** Transparency-log public keys hosts pin inclusion proofs against (SPEC §4.3). */
  readonly logPublicKeys?: readonly string[];
}

/**
 * Generate the document from a loaded {@link Config}, at instant `now`. Throws a
 * {@link TrustRootInitError} when no countersign key is configured (the root has
 * nothing to anchor) or when the produced document does not narrow back through
 * the protocol's own {@link parseTrustRoot} — the exact gate a host runs, so a
 * document this script writes is one a host will parse.
 */
export function generateTrustRootDoc(
  config: Config,
  now: number,
  validityDays: number,
  extra: ExtraRoots = {},
): TrustRootDoc {
  const identity = loadCountersignIdentity(config.countersign);
  if (identity === null) {
    throw new TrustRootInitError(
      'no countersign key is configured — set COUNTERSIGN_PRIVATE_KEY and ' +
        'COUNTERSIGN_CERTIFICATE first (see docs/countersign.md for the openssl recipe). ' +
        'The trust root anchors the registry approval signature, so a countersign key ' +
        'is required to generate one.',
    );
  }

  const doc = buildTrustRootDoc({
    registryId: config.registryId,
    countersignRoots: [deriveCountersignRoot(identity.publicKeySpkiDer)],
    issuerAllowlist: config.oidc.issuerAllowlist,
    // Keyless OIDC is this cut's authorship path; a publisher-CA root is supplied
    // out of band by an operator who issues publisher certs (SPEC §4.4, optional).
    publisherCARoots: extra.publisherCARoots ?? [],
    // The in-process `memory` log's key is ephemeral (regenerated each boot) and
    // not a durable pin, so it is not emitted; an operator anchoring to a durable
    // log (Rekor) supplies its pinned key here. Empty is valid (SPEC §4.3).
    logPublicKeys: extra.logPublicKeys ?? [],
    notBefore: now,
    notAfter: now + validityDays * 24 * 60 * 60 * 1000,
  });

  const parsed = parseTrustRoot(doc);
  if (!parsed.ok) {
    // Should be unreachable — a bug in this builder, surfaced loudly rather than
    // writing a document a host would reject.
    throw new TrustRootInitError(
      `generated trust-root document failed protocol validation: ${parsed.reason}`,
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

  const validityRaw = flagValue('--validity-days');
  let validityDays = DEFAULT_VALIDITY_DAYS;
  if (validityRaw !== undefined) {
    const parsed = Number(validityRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new TrustRootInitError(`--validity-days must be a positive integer, got "${validityRaw}"`);
    }
    validityDays = parsed;
  }

  return {
    out: flagValue('--out') ?? 'trust-root.json',
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
  const doc = generateTrustRootDoc(config, Date.now(), options.validityDays, {
    publisherCARoots: readList(env.TRUST_ROOT_PUBLISHER_CA_ROOTS),
    logPublicKeys: readList(env.TRUST_ROOT_LOG_PUBLIC_KEYS),
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
  process.stdout.write(`wrote ${options.out} for registry "${doc.registryId}"\n`);
  process.stdout.write(`  countersign root (pin this): ${doc.countersignRoots.join(', ')}\n`);
  process.stdout.write(
    `  valid ${new Date(doc.notBefore).toISOString()} → ${new Date(doc.notAfter).toISOString()}\n`,
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
