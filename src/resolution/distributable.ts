/**
 * The single **distributability** predicate the registry gates loadable content
 * on (SPEC §3, §6). An artifact is distributable — a host may load it, and the
 * catalog may list it — only when it is:
 *
 *  1. in the **`approved`** lifecycle state (not submitted/reviewing/rejected, and
 *     not revoked/killed — a revoke/kill moves it out of `approved`);
 *  2. **not** listed revoked/killed in the signed revocation feed (the `state ∧
 *     feed` cross-check, SPEC §6 — catches the window before a feed write is
 *     reflected in the state); and
 *  3. backed by a **countersigned release document** that carries a
 *     **transparency-log inclusion entry** (a host cannot verify it otherwise).
 *
 * Resolution (`./resolve`) and the widgets catalog (`../widgets`) both gate on
 * this one function so "what a host can load" and "what the catalog lists" can
 * never drift. Pure over already-fetched inputs; the callers do the I/O.
 */
import type { ArtifactState } from '../artifact/types.js';

/** The only lifecycle state a distributable artifact may be in (SPEC §3, §6). */
export const DISTRIBUTABLE_STATE: ArtifactState = 'approved';

/**
 * The outcome of the distributability gate. The three non-`distributable` values
 * are exactly resolution's `ExclusionReason`s for this gate, so `./resolve` can
 * return them verbatim.
 */
export type DistributabilityOutcome =
  | 'distributable'
  | 'not_distributable' // not `approved`, or revoked/killed in the signed feed
  | 'no_release' // `approved` but no countersigned release document
  | 'unresolvable_release'; // release exists but carries no transparency-log entry

export interface DistributabilityInput {
  /** The artifact's lifecycle state. */
  readonly state: ArtifactState;
  /** Whether the signed revocation/kill feed lists this artifact (the §6 cross-check). */
  readonly revoked: boolean;
  /** Whether a countersigned release document exists for the artifact. */
  readonly hasRelease: boolean;
  /** Whether that release document carries a transparency-log inclusion entry. */
  readonly hasLogEntry: boolean;
}

/** Classify an artifact's distributability from its already-fetched gate inputs. */
export function classifyDistributability(input: DistributabilityInput): DistributabilityOutcome {
  if (input.state !== DISTRIBUTABLE_STATE) return 'not_distributable';
  if (input.revoked) return 'not_distributable';
  if (!input.hasRelease) return 'no_release';
  if (!input.hasLogEntry) return 'unresolvable_release';
  return 'distributable';
}

/** True iff the artifact is loadable/listable — the boolean form of {@link classifyDistributability}. */
export function isDistributable(input: DistributabilityInput): boolean {
  return classifyDistributability(input) === 'distributable';
}
