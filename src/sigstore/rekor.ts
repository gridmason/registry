/**
 * Rekor transparency-log client (SPEC §2, §4.3, GW-D17) — the production log the
 * flagship anchors releases in.
 *
 * GW-D17: the flagship anchors to the **public Sigstore infrastructure** (Rekor
 * as the log) rather than operating its own. This client submits a `hashedrekord`
 * entry for the countersigned release and maps Rekor's response — which already
 * speaks the RFC 6962 inclusion proof + c2sp signed-note checkpoint the
 * `@gridmason/protocol` verify lib checks — onto our {@link TransparencyLogEntry}.
 * That shared wire shape is exactly why GW-D17 chose Rekor: a host runs the same
 * `verifyLogInclusion` against a Rekor entry as against the in-process log.
 *
 * Availability boundary (the SPEC's open question, evaluated in
 * `docs/countersign.md`): this depends on the public Rekor instance being
 * reachable and within its rate limits at countersign time. A submission failure
 * surfaces as a thrown error the stage records — the release is not marked logged.
 * The self-hosted-Rekor fallback for when the public instance is unavailable is
 * Phase C and is deliberately not built here.
 *
 * `fetch` is injectable so the response mapping is unit-tested without a network.
 */
import type { TransparencyLogEntry } from '@gridmason/protocol';

import type { LogAppendInput, LogAppendResult, TransparencyLog } from './log.js';

/** The subset of `fetch` this client uses; injectable for tests. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface RekorClientOptions {
  /** Base URL of the Rekor instance, e.g. `https://rekor.sigstore.dev`. */
  readonly baseUrl: string;
  /** Transport; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

/** Rekor's inclusion-proof shape inside `verification.inclusionProof`. */
interface RekorInclusionProof {
  readonly logIndex: number;
  readonly rootHash: string;
  readonly treeSize: number;
  readonly hashes: readonly string[];
  readonly checkpoint: string;
}

interface RekorEntry {
  readonly logID: string;
  readonly logIndex: number;
  readonly integratedTime: number;
  readonly body: string;
  readonly verification?: { readonly inclusionProof?: RekorInclusionProof };
}

/** The multihash-tagged hash's bare hex digest (`sha2-256:<hex>` → `<hex>`). */
function multihashDigestHex(releaseHash: string): string {
  const colon = releaseHash.indexOf(':');
  return colon === -1 ? releaseHash : releaseHash.slice(colon + 1);
}

/**
 * Build a Rekor `hashedrekord` v0.0.1 proposed entry over the countersigned
 * release: the release content hash as the data digest, the countersignature, and
 * the countersign certificate as the public key.
 */
function proposedEntry(input: LogAppendInput): unknown {
  return {
    apiVersion: '0.0.1',
    kind: 'hashedrekord',
    spec: {
      data: {
        hash: { algorithm: 'sha256', value: multihashDigestHex(input.releaseHash) },
      },
      signature: {
        content: input.signatureB64,
        publicKey: { content: input.certificateB64 },
      },
    },
  };
}

/** Map a Rekor entry + its inclusion proof onto our protocol entry shape. */
function toEntry(rekor: RekorEntry): TransparencyLogEntry {
  const proof = rekor.verification?.inclusionProof;
  if (proof === undefined) {
    throw new Error('Rekor response carried no inclusion proof');
  }
  return {
    logId: rekor.logID,
    index: proof.logIndex,
    integratedTime: rekor.integratedTime,
    canonicalBody: rekor.body,
    inclusionProof: {
      treeSize: proof.treeSize,
      rootHash: proof.rootHash,
      hashes: [...proof.hashes],
    },
    checkpoint: proof.checkpoint,
  };
}

/** A {@link TransparencyLog} backed by a Rekor instance over HTTP. */
export class RekorTransparencyLog implements TransparencyLog {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: RekorClientOptions) {
    // Trim a trailing slash so the path join is unambiguous.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  async append(input: LogAppendInput): Promise<LogAppendResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/log/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(proposedEntry(input)),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Rekor submission failed (${response.status}): ${text}`);
    }
    // Rekor keys the response by entry UUID; the entry is the single value.
    const parsed = JSON.parse(text) as Record<string, RekorEntry>;
    const uuids = Object.keys(parsed);
    const uuid = uuids[0];
    if (uuid === undefined) {
      throw new Error('Rekor response contained no entry');
    }
    const entry = toEntry(parsed[uuid]!);
    return { entry, logRef: `${entry.logId}:${entry.index}` };
  }
}
