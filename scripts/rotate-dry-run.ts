/**
 * Rotation dry-run — walk an overlap-window rotation end to end and prove a host
 * accepts either root during the overlap (FR-9 acceptance; SPEC §4.4).
 *
 * This is the validating dry-run the rotation runbook is measured against. It runs
 * the whole ceremony against ephemeral, throwaway keys — no live registry, no
 * database — and checks each claim with the **host's own** `@gridmason/protocol`
 * functions (`parseTrustRoot`, `evaluateTrustRoot`), so what it proves is exactly
 * what a real host would decide:
 *
 *   1. Mint an outgoing and an incoming P-256 countersign key with the documented
 *      `openssl` recipe (the same commands `docs/self-host/install.md` uses).
 *   2. Build the overlap document with {@link generateOverlapDoc} — both roots,
 *      cross-signed by the outgoing key.
 *   3. Deliver it as a host would (round-trip through JSON) and check that a host
 *      pinned to the **outgoing** root, and a host pinned to the **incoming** root,
 *      both trust it — while a host pinned to neither is refused (fail-closed).
 *   4. Verify the `crossSig` cryptographically under the outgoing root — the check
 *      `verifyRelease` runs before it will believe an overlap document (SPEC §4.4).
 *   5. Complete the rotation: drop the outgoing root (a single-root document under
 *      the incoming key, via install-time generation) and confirm a host still
 *      pinned only to the outgoing root is now refused.
 *
 * Run it with `npm run rotate:dry-run`; the transcript is captured in
 * `docs/self-host/rotation.md`. It exits non-zero if any host decision disagrees
 * with the runbook — so it is a live check of the documented behaviour, not a
 * narration of it. It shells out to `openssl` (a prerequisite for self-hosting) and
 * is a docs/ops helper: not part of the running service, not shipped in the image.
 */
import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalize,
  evaluateTrustRoot,
  parseTrustRoot,
  type TrustRootDoc,
  type TrustRootPin,
} from '@gridmason/protocol';

import { loadConfig } from '../src/config/index.js';
import { loadCountersignIdentity } from '../src/countersign/index.js';
import { generateTrustRootDoc } from './trust-root-init.js';
import { deriveIncomingRoot, generateOverlapDoc } from './rotate-root.js';

const REGISTRY_ID = 'registry.dry-run.example';
const ISSUER_ALLOWLIST = 'https://token.actions.githubusercontent.com';
/** A fixed instant so the transcript's validity window reads the same each run. */
const NOW = Date.UTC(2026, 6, 14);

let failures = 0;

/** Assert `cond`, printing a ✓/✗ line; a failure is recorded and fails the run. */
function check(cond: boolean, label: string): void {
  process.stdout.write(`  ${cond ? '✓' : '✗ FAIL'} ${label}\n`);
  if (!cond) failures += 1;
}

/** Generate a P-256 key + self-signed countersign cert with the documented recipe. */
function mintCountersignKey(dir: string, name: string): { keyPem: string; certPem: string } {
  const keyPath = join(dir, `${name}.key`);
  const certPath = join(dir, `${name}.crt`);
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
  execFileSync('openssl', [
    'req', '-x509', '-new', '-key', keyPath, '-days', '365',
    '-subj', `/CN=${REGISTRY_ID} ${name} countersign`, '-out', certPath,
  ]);
  return { keyPem: readFileSync(keyPath, 'utf8'), certPem: readFileSync(certPath, 'utf8') };
}

/** Deliver a document as a host receives it (over the wire) and narrow it back. */
function asDelivered(doc: TrustRootDoc): TrustRootDoc {
  const parsed = parseTrustRoot(JSON.parse(JSON.stringify(doc)) as unknown);
  if (!parsed.ok) throw new Error(`document did not parse as a host would: ${parsed.reason}`);
  return parsed.doc;
}

function pin(root: string): TrustRootPin {
  return { registryId: REGISTRY_ID, root, channel: 'deploy-time' };
}

/**
 * Verify a `crossSig` the way `verifyRelease` does (SPEC §4.4): the outgoing root's
 * signature over the canonical bytes of the document with `crossSig` removed.
 */
function crossSigVerifies(doc: TrustRootDoc, outgoingSpkiDer: Uint8Array): boolean {
  if (doc.crossSig === undefined) return false;
  const { crossSig, ...withoutCrossSig } = doc;
  const preimage = canonicalize(withoutCrossSig);
  const key = createPublicKey({ key: Buffer.from(outgoingSpkiDer), format: 'der', type: 'spki' });
  return verify(
    'sha256',
    preimage,
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(crossSig, 'base64'),
  );
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), 'gridmason-rotate-'));
  try {
    process.stdout.write('Rotation dry-run — overlap-window countersign-root rotation\n\n');

    // 1. Two throwaway countersign keys: the outgoing (current) and the incoming (new).
    const outgoingPem = mintCountersignKey(dir, 'outgoing');
    const incomingPem = mintCountersignKey(dir, 'incoming');

    const config = loadConfig({
      REGISTRY_ID,
      OIDC_ISSUER_ALLOWLIST: ISSUER_ALLOWLIST,
      COUNTERSIGN_PRIVATE_KEY: outgoingPem.keyPem,
      COUNTERSIGN_CERTIFICATE: outgoingPem.certPem,
    });
    const outgoing = loadCountersignIdentity(config.countersign);
    if (outgoing === null) throw new Error('outgoing key failed to load');
    const incoming = deriveIncomingRoot(incomingPem.certPem);

    // 2. Build the overlap document (both roots, cross-signed by the outgoing key).
    const overlap = generateOverlapDoc({
      config,
      outgoing,
      incomingRoot: incoming.root,
      now: NOW,
      validityDays: 365,
    });
    const [rotOutRoot, rotInRoot] = overlap.countersignRoots;
    process.stdout.write('Step 1–2 — overlap document generated\n');
    process.stdout.write(`  outgoing root: ${rotOutRoot}\n`);
    process.stdout.write(`  incoming root: ${rotInRoot}\n`);
    process.stdout.write(
      `  valid ${new Date(overlap.notBefore).toISOString()} → ${new Date(overlap.notAfter).toISOString()}\n`,
    );
    check(overlap.countersignRoots.length === 2, 'document lists both roots');
    check(overlap.crossSig !== undefined, 'document carries a crossSig');
    check(
      crossSigVerifies(overlap, outgoing.publicKeySpkiDer),
      'crossSig verifies under the outgoing root (verifyRelease §4.4 check)',
    );

    // 3. During overlap: a host pinned to EITHER root trusts the document.
    process.stdout.write('\nStep 3 — during the overlap window (host decisions)\n');
    const delivered = asDelivered(overlap);
    const pinnedOutgoing = evaluateTrustRoot(delivered, [pin(rotOutRoot)], NOW);
    const pinnedIncoming = evaluateTrustRoot(delivered, [pin(rotInRoot)], NOW);
    const pinnedStranger = evaluateTrustRoot(delivered, [pin('sha256:0000')], NOW);
    check(
      pinnedOutgoing.ok && pinnedOutgoing.overlap && pinnedOutgoing.matchedRoot === rotOutRoot,
      'host pinned to the OUTGOING root → trusted (overlap)',
    );
    check(
      pinnedIncoming.ok && pinnedIncoming.overlap && pinnedIncoming.matchedRoot === rotInRoot,
      'host pinned to the INCOMING root → trusted (overlap)',
    );
    check(
      !pinnedStranger.ok && pinnedStranger.code === 'unpinned',
      'host pinned to neither root → refused (fail-closed)',
    );

    // 4. Complete the rotation: drop the outgoing root (single-root doc, incoming key).
    process.stdout.write('\nStep 4 — after the window: drop the outgoing root\n');
    const droppedConfig = loadConfig({
      REGISTRY_ID,
      OIDC_ISSUER_ALLOWLIST: ISSUER_ALLOWLIST,
      COUNTERSIGN_PRIVATE_KEY: incomingPem.keyPem,
      COUNTERSIGN_CERTIFICATE: incomingPem.certPem,
    });
    const dropped = asDelivered(generateTrustRootDoc(droppedConfig, NOW, 365));
    process.stdout.write(`  new document lists only: ${dropped.countersignRoots.join(', ')}\n`);
    const stillOldPinned = evaluateTrustRoot(dropped, [pin(rotOutRoot)], NOW);
    const nowNewPinned = evaluateTrustRoot(dropped, [pin(rotInRoot)], NOW);
    check(
      dropped.countersignRoots.length === 1 && dropped.countersignRoots[0] === rotInRoot,
      'dropped document carries only the incoming root',
    );
    check(
      !stillOldPinned.ok && stillOldPinned.code === 'unpinned',
      'host still pinned only to the OUTGOING root → refused (must re-pin)',
    );
    check(nowNewPinned.ok, 'host pinned to the INCOMING root → trusted');

    process.stdout.write(
      `\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — hosts accept either root during overlap; ` +
        'the outgoing root is refused once dropped.\n',
    );
    return failures === 0 ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
