/**
 * RFC 6962 Merkle tree construction — the *producer* side of the transparency
 * log (SPEC §4.3).
 *
 * `@gridmason/protocol`'s verify lib (`verify/log/merkle`) is a pure *verifier*:
 * given a leaf, a size, and an audit path it recomputes a root. It ships no tree
 * *builder* — a log server has to compute the tree head and the audit path itself.
 * This is that builder, deliberately hashing with the identical RFC 6962 rules so
 * every entry the in-process log emits verifies against the protocol verifier:
 *
 *  - leaf hash   `SHA-256(0x00 || data)`
 *  - interior    `SHA-256(0x01 || left || right)`
 *  - split       largest power of two `< n` (RFC 6962 §2.1)
 *  - audit path  RFC 6962 `PATH(m, D)`, ordered leaf → root
 *
 * The audit path this produces is exactly what `rootFromInclusionProof(index,
 * size, leaf, path)` folds back to the root; the log module's tests assert that
 * round-trip against the protocol lib, so a drift from the verifier fails CI here
 * rather than in a host.
 *
 * Node's `crypto` SHA-256 is used (this is server code); SHA-256 is SHA-256, so
 * the digests are byte-identical to the verifier's WebCrypto ones.
 */
import { createHash } from 'node:crypto';

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

function sha256(...chunks: readonly Uint8Array[]): Uint8Array {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return new Uint8Array(hash.digest());
}

/** The RFC 6962 leaf hash `SHA-256(0x00 || data)`. */
export function leafHash(data: Uint8Array): Uint8Array {
  return sha256(LEAF_PREFIX, data);
}

/** The RFC 6962 interior node hash `SHA-256(0x01 || left || right)`. */
function hashChildren(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(NODE_PREFIX, left, right);
}

/** Largest power of two strictly less than `n` (`n > 1`). */
function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

/**
 * The RFC 6962 Merkle tree hash of the leaf-data slice `leaves` — the signed tree
 * head's root at `leaves.length`. Empty is not a valid state for this log (a
 * checkpoint is only issued after an append), so callers pass `length >= 1`.
 */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  const n = leaves.length;
  if (n === 1) return leafHash(leaves[0]!);
  const k = largestPowerOfTwoBelow(n);
  return hashChildren(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/**
 * The RFC 6962 inclusion (audit) path for leaf `index` in the tree of `leaves`,
 * ordered leaf → root — the exact `proof` `rootFromInclusionProof` expects. The
 * hashes are raw 32-byte digests; the log module hex-encodes them for the wire.
 */
export function inclusionPath(index: number, leaves: readonly Uint8Array[]): Uint8Array[] {
  const n = leaves.length;
  if (n === 1) return [];
  const k = largestPowerOfTwoBelow(n);
  if (index < k) {
    return [...inclusionPath(index, leaves.slice(0, k)), merkleRoot(leaves.slice(k))];
  }
  return [...inclusionPath(index - k, leaves.slice(k)), merkleRoot(leaves.slice(0, k))];
}
