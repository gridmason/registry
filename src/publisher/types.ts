/**
 * Publisher record shape + the value rules the API enforces (SPEC §5, §9).
 *
 * A publisher record is the identity/ownership foundation the later publish and
 * review lanes key against: an OIDC-bound identity, the namespace `prefix` that
 * governs which widget `tag`s it may publish under, and an identity tier the
 * reviewer≠author + waiver logic will later read.
 */

/**
 * Publisher identity tier (SPEC §5): community (account + email age) → verified
 * (domain proof + legal entity) → operator (the registry operator's own team,
 * bound by §2 separation of duties). This phase stores the tier as an attribute
 * only — there is no domain-proof automation yet (SCOPE cut) — but the field is
 * kept so the review lane can key its reviewer≠author + waiver logic on it.
 */
export type PublisherTier = 'community' | 'verified' | 'operator';

export const PUBLISHER_TIERS: readonly PublisherTier[] = [
  'community',
  'verified',
  'operator',
];

export function isPublisherTier(value: unknown): value is PublisherTier {
  return (
    typeof value === 'string' && (PUBLISHER_TIERS as readonly string[]).includes(value)
  );
}

/** A stored publisher record (registry-agnostic; outputs qualify it by registry id). */
export interface PublisherRecord {
  readonly id: string;
  /** OIDC `iss` — the trust anchor (SPEC §2). */
  readonly issuer: string;
  /** OIDC `sub` — the subject, unique within the issuer. */
  readonly subject: string;
  /** Namespace prefix owned by this publisher (unique within the registry). */
  readonly prefix: string;
  readonly tier: PublisherTier;
  readonly createdAt: Date;
}

/**
 * Canonical composite of the identity claims, stored in the `oidc_identity`
 * column whose unique index is the per-registry identity key. Issuers are URLs
 * and subjects are opaque ids — neither contains whitespace — so a single space
 * is an unambiguous, human-readable separator (and, unlike NUL, is a legal
 * Postgres `text` value).
 */
export function composeOidcIdentity(issuer: string, subject: string): string {
  return `${issuer} ${subject}`;
}

/** Why a prefix was rejected. Callers switch on the code, not the message. */
export type PrefixViolationCode = 'empty' | 'too-long' | 'invalid-characters';

// A prefix is the leading segment of a custom-element tag (SPEC §5, manifest
// §3.1): lowercase, starts with a letter, `[a-z0-9]` groups joined by single
// hyphens, no leading/trailing/doubled hyphen. Tags the publisher ships must
// begin `<prefix>-`; the full tag rules live in `@gridmason/protocol` (lintTag)
// and are enforced at publish time (#7+), not here.
const PREFIX_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PREFIX_MAX_LENGTH = 63;

/** Validate a namespace prefix; returns the first violation, or `null` if valid. */
export function validatePrefix(prefix: string): PrefixViolationCode | null {
  if (prefix === '') return 'empty';
  if (prefix.length > PREFIX_MAX_LENGTH) return 'too-long';
  if (!PREFIX_PATTERN.test(prefix)) return 'invalid-characters';
  return null;
}
