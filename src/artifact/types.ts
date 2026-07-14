/**
 * Artifact record shape (registry-v0 spec §"Data model"; SPEC §3).
 *
 * A submitted artifact is the content-addressed, immutable unit the review lane
 * acts on: a `(publisher, tag, version)` identity, the `{path → content hash}`
 * map of the exact served bytes (`content_hashes`, SPEC §3), a reference to the
 * signed source archive (`source_archive_ref`, the GW-D19 interim review input),
 * the attached publisher signature envelope (stored opaquely this phase), and a
 * lifecycle `state` that starts at `submitted`.
 */
import type { MultihashString } from '@gridmason/protocol';

/**
 * Artifact lifecycle states (migration 0001 `artifact_state_check`). Publish
 * intake only ever writes `submitted`; the later stages advance it. Content and
 * identity columns are frozen once written (the immutability trigger), so the
 * `state` is the only mutable field.
 */
export type ArtifactState =
  | 'submitted'
  | 'reviewing'
  | 'approved'
  | 'rejected'
  | 'revoked'
  | 'killed';

export const ARTIFACT_STATES: readonly ArtifactState[] = [
  'submitted',
  'reviewing',
  'approved',
  'rejected',
  'revoked',
  'killed',
];

/**
 * `{ served path → content hash }` for every file the runtime may load
 * (manifest + `entry` + chunks + schemas + docs). The hash is the multihash-
 * tagged SHA-256 of the file's **exact served bytes** (`@gridmason/protocol`
 * {@link MultihashString}); the CDN serves by that hash and the signed release
 * (emitted later) pins this same map.
 */
export type ContentHashMap = { readonly [path: string]: MultihashString };

/** A stored artifact record (registry-agnostic; outputs qualify it by registry id). */
export interface ArtifactRecord {
  readonly id: string;
  readonly publisherId: string;
  /** The widget custom-element tag; falls under the publisher's namespace prefix. */
  readonly tag: string;
  readonly version: string;
  readonly contentHashes: ContentHashMap;
  /**
   * Object-store key (a content hash) of the signed source archive the reviewer
   * builds/spot-checks (GW-D19 interim, SPEC §3). `null` only for records that
   * predate the field; intake always sets it.
   */
  readonly sourceArchiveRef: string | null;
  /**
   * The publisher signature envelope that rode in with the upload. Stored
   * opaquely this phase (structural validation only — see `./envelope`);
   * cryptographic verification against the `@gridmason/protocol` envelope types
   * lands with countersign (#10).
   */
  readonly envelope: unknown;
  readonly state: ArtifactState;
  readonly createdAt: Date;
}
