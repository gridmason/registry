/**
 * Revocation-feed document construction + signing (SPEC §6, FR-8).
 *
 * The served feed is two layers:
 *  - the protocol {@link RevocationFeed} document (`@gridmason/protocol`) — the
 *    shape a host passes to `evaluateFreshness`. Built from a
 *    {@link import('./store.js').FeedSnapshot}: the snapshot's monotonic `seq`
 *    becomes the feed version, `issuedAt`/`ttlSeconds` carry the freshness window,
 *    and each blocking artifact becomes a `RevocationEntry`.
 *  - a detached {@link SignedRevocationFeed} envelope that binds a registry
 *    signature to the feed's canonical bytes. The protocol models the document
 *    shape only ("verifying the feed's signature is the signature primitives'
 *    job"); this transport is how the registry ships the signature. It is signed
 *    with the **same countersign key** as release approval (SPEC §6 — "hosts
 *    verify the feed against the same trust root"), so a host pins one countersign
 *    root for both.
 *
 * Signing covers `canonicalize(feed)` (RFC-8785, `src/canon` via the protocol) so
 * a verifier reconstructs byte-identical input from the feed it received; the
 * signature is ECDSA P-256 / SHA-256 in IEEE-P1363 form, the encoding the
 * protocol verify lib consumes.
 */
import { canonicalize } from '@gridmason/protocol';
import type { RevocationFeed } from '@gridmason/protocol';

import type { CountersignIdentity } from '../countersign/identity.js';
import type { FeedSnapshot } from './store.js';

/**
 * The revocation-feed wire-format version this cut emits (`major.minor`). Part of
 * the canonical bytes the signature covers, so producer and verifier must agree;
 * a format bump is a protocol-negotiated change (SPEC §7).
 */
export const REVOCATION_FEED_FORMAT_VERSION = '1.0';

export interface BuildRevocationFeedInput {
  /** This registry's source-qualified id; must match the host's cursor. */
  readonly registryId: string;
  /** The current feed data (monotonic version + blocking artifacts). */
  readonly snapshot: FeedSnapshot;
  /** When the feed is issued, epoch milliseconds (the clock a host compares to). */
  readonly issuedAt: number;
  /** Freshness window in seconds from `issuedAt` (SPEC §6 max is 24 h). */
  readonly ttlSeconds: number;
}

/** Build the protocol {@link RevocationFeed} document from a snapshot. */
export function buildRevocationFeed(input: BuildRevocationFeedInput): RevocationFeed {
  return {
    formatVersion: REVOCATION_FEED_FORMAT_VERSION,
    registryId: input.registryId,
    seq: input.snapshot.seq,
    issuedAt: input.issuedAt,
    ttlSeconds: input.ttlSeconds,
    entries: input.snapshot.entries.map((entry) => ({
      artifact: entry.artifact,
      state: entry.state,
      severity: entry.severity,
      reason: entry.reason,
    })),
  };
}

/** The detached registry signature over a feed's canonical bytes. */
export interface RevocationFeedSignature {
  /** Signature algorithm; `ES256` at format `1.x`. */
  readonly alg: 'ES256';
  /** Base64 (standard alphabet) of the DER-encoded countersign X.509 certificate. */
  readonly cert: string;
  /** Base64 (standard alphabet) of the IEEE-P1363 ECDSA signature over `canonicalize(feed)`. */
  readonly sig: string;
}

/**
 * A signed revocation feed as served: the protocol {@link RevocationFeed} document
 * plus the registry signature over its canonical bytes. A host verifies the
 * signature (against a pinned countersign root), then passes `feed` to
 * `evaluateFreshness`.
 */
export interface SignedRevocationFeed {
  readonly feed: RevocationFeed;
  readonly signature: RevocationFeedSignature;
}

/** The canonical bytes (JCS / RFC-8785) of a feed — what its signature covers. */
export function canonicalFeedBytes(feed: RevocationFeed): Uint8Array {
  return canonicalize(feed);
}

/** Sign a feed with the registry countersign identity, producing the served envelope. */
export function signRevocationFeed(
  feed: RevocationFeed,
  identity: CountersignIdentity,
): SignedRevocationFeed {
  const sig = identity.sign(canonicalFeedBytes(feed));
  return {
    feed,
    signature: {
      alg: 'ES256',
      cert: Buffer.from(identity.certificateDer).toString('base64'),
      sig: Buffer.from(sig).toString('base64'),
    },
  };
}
