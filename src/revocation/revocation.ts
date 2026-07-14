/**
 * Revocation & kill service — the distribution-state authority half of the §6
 * ownership contract (SPEC §6, FR-8, FR-12).
 *
 * A registry owns distribution state; a host owns enablement. This service is
 * where the registry exercises its half: it moves a published (approved)
 * artifact to `revoked` or `killed` through the guarded
 * {@link ArtifactStore.transition} state machine, appends the matching
 * {@link FeedEntryStore} row (so the signed feed reflects it on the next fetch),
 * and emits an {@link emitAuditEvent} (FR-12). It is **not** a control plane: it
 * publishes state, it does not reach into any host.
 *
 * Two effects flow from a transition and together keep a killed remote out of
 * every import map (SPEC §6):
 *  - the artifact leaves `approved`, so the resolution surface's approved-only
 *    candidate set no longer contains it (excluded at the source registry);
 *  - the feed lists it as revoked/killed, so a host that still holds a cached
 *    release doc blocks (and, for `killed`, force-unloads) it via the protocol's
 *    `evaluateFreshness`.
 *
 * Valid transitions: `approved → revoked`, `approved → killed`, and the escalation
 * `revoked → killed`. Anything else (already killed, never approved) is refused as
 * `invalid-state`; a missing artifact is `not-found`.
 */
import type { RevocationSeverity } from '@gridmason/protocol';

import { emitAuditEvent } from '../audit/index.js';
import type { ArtifactStore } from '../artifact/store.js';
import type { ArtifactRecord } from '../artifact/types.js';
import type { FeedEntryStore, FeedTransitionState } from './store.js';

/** The audit action verbs this service emits (FR-12). */
const REVOKE_ACTION = 'artifact.revoked';
const KILL_ACTION = 'artifact.killed';

/** A request to revoke or kill an artifact. */
export interface IssueRevocationInput {
  /** The `artifact` table id (uuid). */
  readonly artifactId: string;
  /** Advisory triage severity carried in the feed entry (does not change the block). */
  readonly severity: RevocationSeverity;
  /** Human-readable justification, recorded on the entry and audited. */
  readonly reason: string;
  /** The operator identity issuing the action (the audit actor). */
  readonly actor: string;
}

/** Why a revoke/kill was refused. The route maps each to a response. */
export type RevocationRejection = 'not-found' | 'invalid-state';

export interface RevocationOutcome {
  /** The artifact after the transition. */
  readonly artifact: ArtifactRecord;
  /** The monotonic feed seq the appended entry got (the feed's new version). */
  readonly seq: number;
  /** The state the artifact was moved to. */
  readonly state: FeedTransitionState;
}

export type RevocationResult =
  | { readonly ok: true; readonly outcome: RevocationOutcome }
  | { readonly ok: false; readonly rejection: RevocationRejection };

/** The artifact's wire id: publisher-prefixed tag, version-qualified (`tag@version`). */
function artifactWireId(artifact: ArtifactRecord): string {
  return `${artifact.tag}@${artifact.version}`;
}

export interface RevocationService {
  /** Withdraw a published artifact: `approved → revoked`. Blocks new loads. */
  revoke(input: IssueRevocationInput): Promise<RevocationResult>;
  /** Kill an artifact: `approved`/`revoked → killed`. Blocks new loads and unloads. */
  kill(input: IssueRevocationInput): Promise<RevocationResult>;
}

export interface RevocationServiceDeps {
  readonly artifactStore: ArtifactStore;
  readonly feedEntryStore: FeedEntryStore;
}

export function createRevocationService(deps: RevocationServiceDeps): RevocationService {
  const { artifactStore, feedEntryStore } = deps;

  /**
   * Classify a failed transition: an absent artifact is `not-found`, an artifact
   * in the wrong state is `invalid-state`. Read after the guarded transition
   * returned null, so it only decides which refusal to report.
   */
  async function classifyFailure(artifactId: string): Promise<RevocationRejection> {
    const existing = await artifactStore.findById(artifactId);
    return existing ? 'invalid-state' : 'not-found';
  }

  /**
   * Shared finish: append the feed entry (bumping the monotonic seq) and audit,
   * once a transition has committed. Both effects follow the state move, so a host
   * sees the feed change and the audit log records who did it.
   */
  async function publish(
    artifact: ArtifactRecord,
    state: FeedTransitionState,
    input: IssueRevocationInput,
    action: string,
  ): Promise<RevocationResult> {
    const entry = await feedEntryStore.append({
      artifactId: artifact.id,
      artifact: artifactWireId(artifact),
      state,
      severity: input.severity,
      reason: input.reason,
    });
    emitAuditEvent(input.actor, action, artifact.id);
    return { ok: true, outcome: { artifact, seq: entry.seq, state } };
  }

  return {
    async revoke(input) {
      const moved = await artifactStore.transition(input.artifactId, 'approved', 'revoked');
      if (!moved) return { ok: false, rejection: await classifyFailure(input.artifactId) };
      return publish(moved, 'revoked', input, REVOKE_ACTION);
    },

    async kill(input) {
      // A kill is valid from `approved` (direct) or `revoked` (escalation); try the
      // direct move first, then the escalation. Either guarded transition is a
      // no-op unless the artifact is actually in that `from` state.
      const moved =
        (await artifactStore.transition(input.artifactId, 'approved', 'killed')) ??
        (await artifactStore.transition(input.artifactId, 'revoked', 'killed'));
      if (!moved) return { ok: false, rejection: await classifyFailure(input.artifactId) };
      return publish(moved, 'killed', input, KILL_ACTION);
    },
  };
}
