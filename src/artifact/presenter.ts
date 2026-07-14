/**
 * API projection of an {@link ArtifactRecord}.
 *
 * Source-qualified with the registry id (SPEC §9), like every other output, so a
 * host resolves the artifact as `(registry, publisher, tag)`. The publisher
 * signature envelope is **not** echoed back: it is intake input the review lane
 * consumes, not part of the submission acknowledgement.
 */
import type { ArtifactRecord, ArtifactState, ContentHashMap } from './types.js';

export interface ArtifactResponse {
  readonly id: string;
  readonly registryId: string;
  readonly publisherId: string;
  readonly tag: string;
  readonly version: string;
  readonly state: ArtifactState;
  /** `{ served path → content hash }` of the immutable, content-addressed bundle. */
  readonly contentHashes: ContentHashMap;
  /** Object-store key (content hash) of the signed source archive. */
  readonly sourceArchiveRef: string | null;
  readonly createdAt: string;
}

export function toArtifactResponse(
  record: ArtifactRecord,
  registryId: string,
): ArtifactResponse {
  return {
    id: record.id,
    registryId,
    publisherId: record.publisherId,
    tag: record.tag,
    version: record.version,
    state: record.state,
    contentHashes: record.contentHashes,
    sourceArchiveRef: record.sourceArchiveRef,
    createdAt: record.createdAt.toISOString(),
  };
}
