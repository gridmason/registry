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
      let logEntry: TransparencyLogEntry;
      let logRef: string;
      try {
        const appended = await transparencyLog.append({
          body: leaf,
          releaseHash,
          signatureB64: countersigned.registrySig.sig,
          certificateB64: countersigned.registrySig.cert,
        });
        logEntry = appended.entry;
        logRef = appended.logRef;
      } catch (err) {
        logger?.error(
          { artifactId: artifact.id, err },
          'countersign: transparency-log append failed; release not published',
        );
        return { ok: false, reason: 'log-append-failed' };
      }

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
        return { ok: false, reason: 'persist-failed' };
      }

      emitAuditEvent(COUNTERSIGN_ACTOR, 'release.logged', publisherEnvelope.subject.artifact);

      return { ok: true, releaseDoc: releaseDocRecord, envelope, logEntry };
    },
  };
}
