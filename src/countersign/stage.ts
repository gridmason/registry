/**
 * The countersign + transparency-logging stage (FR-5, FR-12; SPEC §2, §3, §4a) —
 * the final step of the publish pipeline, run when review passes.
 *
 * On the `reviewing → approved` transition (the human lane, #9) this stage takes
 * the approved artifact's publisher-signed envelope and:
 *
 *  1. **binds** — reproduces the signed release document from the artifact's
 *     content hashes and checks it hashes to the subject the publisher signed
 *     (an artifact whose stored hashes drifted from the signed subject is refused,
 *     never countersigned);
 *  2. **countersigns** — applies the registry approval signature with the
 *     separately-held key (`./identity`, SPEC §2);
 *  3. **anchors** — appends the release to the transparency log, flagging a
 *     flagship-waiver release in the logged leaf (SPEC §4a), and carries the log
 *     inclusion into the envelope;
 *  4. **emits** — persists the signed {@link ReleaseDoc} ({ path → hash } + the
 *     completed envelope + the log entry) for the serving surface (#12);
 *  5. **audits** — a `release.countersigned` event for the signature and a
 *     `release.logged` event for the emission (FR-12).
 *
 * The result is an envelope that verifies via `@gridmason/protocol` — both
 * signatures, the content-hash binding, and log inclusion. A rejected artifact
 * never reaches this stage, so it is never countersigned.
 */
import { hashBytes } from '@gridmason/protocol';
import type { SignatureEnvelope, TransparencyLogEntry } from '@gridmason/protocol';

import type { ArtifactRecord } from '../artifact/types.js';
import { emitAuditEvent } from '../audit/index.js';
import type { Logger } from '../logging/index.js';
import { buildLogLeaf, buildReleaseDoc, canonicalReleaseBytes } from '../release/release-doc.js';
import type { ReleaseDocRecord, ReleaseDocStore } from '../release/store.js';
import type { TransparencyLog } from '../sigstore/index.js';
import { countersignEnvelope, parsePublisherEnvelope } from './countersign.js';
import type { CountersignIdentity } from './identity.js';

/**
 * The actor recorded on countersign audit events. It is the registry's own
 * approval role — deliberately **not** any reviewer identity (SPEC §2 key
 * separation): the countersignature is applied by the custody-held key, not by a
 * person on the review roster.
 */
export const COUNTERSIGN_ACTOR = 'registry:countersign';

/**
 * Bounded retry policy for the transparency-log append (#38). The public Rekor
 * endpoint can fail transiently; rather than dropping the release on the first
 * error, the append is retried a few times with exponential backoff before the
 * stage gives up and records an audited failure. Defaults: 3 attempts, 100 ms base
 * (100/200 ms backoffs) — small enough to stay within a request, generous enough to
 * ride out a blip. Tests inject `{ maxAttempts, baseDelayMs: 0 }` to avoid real waits.
 */
export interface LogAppendRetryPolicy {
  /** Total attempts (≥ 1). The first try is attempt 1; retries follow on failure. */
  readonly maxAttempts: number;
  /** Base backoff in ms; the delay before retry N is `baseDelayMs * 2^(N-1)`. */
  readonly baseDelayMs: number;
}

const DEFAULT_LOG_APPEND_RETRY: LogAppendRetryPolicy = { maxAttempts: 3, baseDelayMs: 100 };

/** Injectable sleep so tests skip real timers; defaults to a real timeout. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CountersignInput {
  /** The approved artifact (state already `approved` when this runs). */
  readonly artifact: ArtifactRecord;
  /** Whether approval rode the disclosed flagship self-review waiver (SPEC §4a). */
  readonly waiverUsed: boolean;
}

/** Why the stage did not produce a published release. */
export type CountersignFailure =
  | 'envelope-unusable'
  | 'release-hash-mismatch'
  | 'log-append-failed'
  | 'persist-failed';

export type CountersignResult =
  | {
      readonly ok: true;
      readonly releaseDoc: ReleaseDocRecord;
      readonly envelope: SignatureEnvelope;
      readonly logEntry: TransparencyLogEntry;
    }
  | { readonly ok: false; readonly reason: CountersignFailure };

export interface CountersignStageDeps {
  readonly identity: CountersignIdentity;
  readonly transparencyLog: TransparencyLog;
  readonly releaseDocStore: ReleaseDocStore;
  readonly logger?: Logger;
  /** Transparency-log append retry policy (#38). Defaults to {@link DEFAULT_LOG_APPEND_RETRY}. */
  readonly logAppendRetry?: LogAppendRetryPolicy;
  /** Sleep between retries; defaults to a real timer. Tests inject a no-op. */
  readonly sleep?: Sleep;
}

export interface CountersignStage {
  /** Countersign, log, and emit the release document for an approved artifact. */
  run(input: CountersignInput): Promise<CountersignResult>;
}

/** Hex Merkle node hashes → base64 for the envelope's advisory log-inclusion transport. */
function hexHashesToBase64(hashes: readonly string[]): string[] {
  return hashes.map((hex) => Buffer.from(hex, 'hex').toString('base64'));
}

export function createCountersignStage(deps: CountersignStageDeps): CountersignStage {
  const { identity, transparencyLog, releaseDocStore, logger } = deps;
  const retry = deps.logAppendRetry ?? DEFAULT_LOG_APPEND_RETRY;
  const sleep = deps.sleep ?? realSleep;

  /**
   * Append to the transparency log, retrying transient failures with bounded
   * exponential backoff (#38). Returns the append result, or `null` when every
   * attempt failed — the caller then records an audited failure and leaves the
   * artifact approved-but-unpublished for the re-drive path.
   */
  async function appendWithRetry(
    input: Parameters<TransparencyLog['append']>[0],
    artifactId: string,
  ): Promise<Awaited<ReturnType<TransparencyLog['append']>> | null> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      try {
        return await transparencyLog.append(input);
      } catch (err) {
        lastErr = err;
        if (attempt < retry.maxAttempts) {
          const delayMs = retry.baseDelayMs * 2 ** (attempt - 1);
          logger?.warn(
            { artifactId, attempt, maxAttempts: retry.maxAttempts, delayMs, err },
            'countersign: transparency-log append failed; retrying',
          );
          await sleep(delayMs);
        }
      }
    }
    logger?.error(
      { artifactId, attempts: retry.maxAttempts, err: lastErr },
      'countersign: transparency-log append failed after retries; release not published',
    );
    return null;
  }

  return {
    async run(input) {
      const { artifact, waiverUsed } = input;

      // 1. Narrow the stored publisher envelope into the protocol shape.
      const parsed = parsePublisherEnvelope(artifact.envelope);
      if (!parsed.ok) {
        logger?.error(
          { artifactId: artifact.id, reason: parsed.reason },
          'countersign: publisher envelope is not usable; release not published',
        );
        return { ok: false, reason: 'envelope-unusable' };
      }
      const publisherEnvelope = parsed.envelope;

      // 2. Reproduce the signed release document and bind it to the signed subject.
      const releaseDoc = buildReleaseDoc(
        publisherEnvelope.subject.artifact,
        artifact.contentHashes,
      );
      const releaseHash = await hashBytes(canonicalReleaseBytes(releaseDoc));
      if (releaseHash !== publisherEnvelope.subject.releaseHash) {
        logger?.error(
          { artifactId: artifact.id },
          'countersign: rebuilt release hash does not match the signed subject; refusing',
        );
        return { ok: false, reason: 'release-hash-mismatch' };
      }

      // 3. Countersign the approved publisher envelope with the custody-held key.
      const countersigned = countersignEnvelope(publisherEnvelope, identity);
      emitAuditEvent(COUNTERSIGN_ACTOR, 'release.countersigned', publisherEnvelope.subject.artifact);

      // 4. Anchor in the transparency log, flagging a waiver release in the leaf.
      const leaf = buildLogLeaf({
        artifact: publisherEnvelope.subject.artifact,
        releaseHash,
        waiver: waiverUsed,
      });
      const appended = await appendWithRetry(
        {
          body: leaf,
          releaseHash,
          signatureB64: countersigned.registrySig.sig,
          certificateB64: countersigned.registrySig.cert,
        },
        artifact.id,
      );
      if (!appended) {
        // Every append attempt failed. The artifact is already `approved`; it stays
        // approved-but-unpublished (no release doc), and the failure is audited so
        // it is visible rather than silent — the re-drive path (`redriveRelease`)
        // completes it once the log recovers. (FR-12, #38.)
        emitAuditEvent(COUNTERSIGN_ACTOR, 'release.log_failed', publisherEnvelope.subject.artifact);
        return { ok: false, reason: 'log-append-failed' };
      }
      const logEntry: TransparencyLogEntry = appended.entry;
      const logRef: string = appended.logRef;

      // 5. Complete the envelope with the log-inclusion transport.
      const envelope: SignatureEnvelope = {
        ...countersigned,
        logInclusion: {
          logId: logEntry.logId,
          index: logEntry.index,
          proof: hexHashesToBase64(logEntry.inclusionProof.hashes),
        },
      };

      // 6. Persist the signed release document.
      let releaseDocRecord: ReleaseDocRecord;
      try {
        releaseDocRecord = await releaseDocStore.create({
          artifactId: artifact.id,
          releaseDoc,
          envelope,
          logRef,
          logEntry,
          waiverFlagged: waiverUsed,
        });
      } catch (err) {
        logger?.error(
          { artifactId: artifact.id, err },
          'countersign: release document persistence failed',
        );
        // The signature and log entry exist, but the release doc did not persist, so
        // the artifact is approved-but-unpublished. Audit the failure (FR-12 — every
        // non-published outcome is visible, mirroring release.log_failed) so the
        // re-drive path (which picks up any approved artifact lacking a release doc)
        // has a recorded reason.
        emitAuditEvent(COUNTERSIGN_ACTOR, 'release.persist_failed', publisherEnvelope.subject.artifact);
        return { ok: false, reason: 'persist-failed' };
      }

      emitAuditEvent(COUNTERSIGN_ACTOR, 'release.logged', publisherEnvelope.subject.artifact);

      return { ok: true, releaseDoc: releaseDocRecord, envelope, logEntry };
    },
  };
}
