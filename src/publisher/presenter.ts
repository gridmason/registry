/**
 * API projections of a {@link PublisherRecord}.
 *
 * Every output is **source-qualified** with the registry id (SPEC §9, FR-10) so
 * a host resolves identity as `(registry, publisher, tag)` and can pin the
 * prefix to this registry. `publishedVersions` and `reviewHistory` are
 * read-through projections of the Artifact / ReviewCase tables (SPEC §5); they
 * are empty until the publish and review lanes land (#7+), and the fields exist
 * now so the response shape is stable across those additions.
 */
import type { PublisherRecord } from './types.js';

export interface PublisherResponse {
  readonly id: string;
  readonly registryId: string;
  readonly identity: { readonly issuer: string; readonly subject: string };
  readonly prefix: string;
  readonly tier: PublisherRecord['tier'];
  readonly createdAt: string;
  /** Read-through projection of Artifact (empty until the publish lane, #7). */
  readonly publishedVersions: readonly never[];
  /** Read-through projection of ReviewCase (empty until the review lane, #8). */
  readonly reviewHistory: readonly never[];
}

export function toPublisherResponse(
  record: PublisherRecord,
  registryId: string,
): PublisherResponse {
  return {
    id: record.id,
    registryId,
    identity: { issuer: record.issuer, subject: record.subject },
    prefix: record.prefix,
    tier: record.tier,
    createdAt: record.createdAt.toISOString(),
    publishedVersions: [],
    reviewHistory: [],
  };
}

/**
 * Prefix ownership is an anonymous, unauthenticated lookup, so it deliberately
 * exposes **only** the registry-local publisher id and tier — never the owner's
 * raw OIDC `issuer`/`subject`. Those identity claims are a fingerprinting
 * surface with no bearing on "who owns this prefix here"; a caller that needs
 * them reads the publisher record by id. (Hardening item 6.)
 */
export interface PrefixOwnershipResponse {
  readonly prefix: string;
  readonly registryId: string;
  readonly owner: {
    readonly publisherId: string;
    readonly tier: PublisherRecord['tier'];
  };
}

export function toPrefixOwnershipResponse(
  record: PublisherRecord,
  registryId: string,
): PrefixOwnershipResponse {
  return {
    prefix: record.prefix,
    registryId,
    owner: {
      publisherId: record.id,
      tier: record.tier,
    },
  };
}
