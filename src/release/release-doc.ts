/**
 * Release-document + transparency-log-leaf construction (SPEC §3, §4a).
 *
 * The signed release document (SPEC §3) lists the exact `{ path → hash }` the
 * runtime may load; its canonical bytes (JCS / RFC-8785) are what the publisher's
 * signature subject hashes, so the registry must reproduce it byte-identically to
 * emit it. This module is the single builder for that document and for the
 * transparency-log leaf the countersign stage anchors, so both sides use one
 * definition of "the bytes".
 */
import { canonicalize } from '@gridmason/protocol';
import type { MultihashString, ReleaseDoc, ReleaseHashMap } from '@gridmason/protocol';

/**
 * The release-document wire-format version this cut emits. A single value for now
 * (a Phase-C format bump persists it per-row); it is part of the canonical bytes
 * the publisher signs, so producer and any reconstruction must agree on it.
 */
export const RELEASE_DOC_FORMAT_VERSION = '1.0';

/** Build the signed release document for an artifact from its content-hash map. */
export function buildReleaseDoc(artifact: string, files: ReleaseHashMap): ReleaseDoc {
  return { formatVersion: RELEASE_DOC_FORMAT_VERSION, artifact, files };
}

/** The canonical bytes (JCS / RFC-8785) of a release document — what its hash covers. */
export function canonicalReleaseBytes(doc: ReleaseDoc): Uint8Array {
  return canonicalize(doc);
}

/**
 * The transparency-log leaf for a countersigned release: the artifact identity,
 * the release hash, and the flagship-waiver flag (SPEC §4a — a release approved
 * under the disclosed self-review waiver is flagged in its log entry). Canonical
 * JCS bytes so the leaf is deterministic and any auditor can decode + inspect it.
 */
export interface ReleaseLogLeaf {
  readonly artifact: string;
  readonly releaseHash: MultihashString;
  /** `true` when the release was approved under the flagship self-review waiver. */
  readonly waiver: boolean;
}

/** Canonical bytes of the transparency-log leaf (the RFC 6962 leaf preimage). */
export function buildLogLeaf(leaf: ReleaseLogLeaf): Uint8Array {
  return canonicalize({
    artifact: leaf.artifact,
    releaseHash: leaf.releaseHash,
    waiver: leaf.waiver,
  });
}
