/**
 * Transparency-log client (SPEC §2, §4.3, GW-D17) — the seam the countersign
 * stage anchors each approved release through.
 *
 * Every countersigned release is appended to a public, append-only transparency
 * log so anyone can audit what the registry shipped (SPEC §2). The registry
 * depends on the {@link TransparencyLog} interface, not on a concrete log: the
 * flagship selects a real Rekor HTTP client (`./rekor`, GW-D17 — anchor to the
 * public Sigstore infrastructure, not a private log), while
 * {@link InMemoryTransparencyLog} backs dev and tests. The in-process log is a
 * faithful RFC 6962 log — real leaf hashing, real audit paths, an Ed25519-signed
 * c2sp checkpoint — so the entries it emits verify against `@gridmason/protocol`'s
 * `verifyLogInclusion` exactly as a Rekor entry would (the acceptance bar).
 *
 * The self-hosted-Rekor fallback (a registry running its own log) is Phase C and
 * is deliberately not built here; see `docs/countersign.md` for the
 * Sigstore-public-instance dependency evaluation.
 */
import {
  createHash,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from 'node:crypto';

import type { TransparencyLogEntry } from '@gridmason/protocol';

import { inclusionPath, merkleRoot } from './merkle.js';

/**
 * What to anchor. `body` is the canonical leaf the in-process log records verbatim
 * (the RFC 6962 leaf preimage); the remaining fields are the structured material a
 * real Rekor `hashedrekord` submission needs. A single log-agnostic input so the
 * stage does not branch on which log is wired — each implementation reads the
 * fields it needs.
 */
export interface LogAppendInput {
  /**
   * The canonical bytes of the leaf to log. The stage builds these from the
   * release subject plus the flagship-waiver flag (SPEC §4a), so the flag is
   * carried in the logged leaf and any auditor can see it. The in-process log
   * hashes these directly; Rekor derives its own entry from the fields below.
   */
  readonly body: Uint8Array;
  /** The release content hash (multihash `sha2-256:<hex>`) — Rekor's hashedrekord data hash. */
  readonly releaseHash: string;
  /** The countersignature, base64 — Rekor's entry signature. */
  readonly signatureB64: string;
  /** The countersign certificate, base64 DER — Rekor's entry public-key material. */
  readonly certificateB64: string;
}

/** The outcome of anchoring one release. */
export interface LogAppendResult {
  /** The Rekor-shaped entry — persisted on the release doc for hosts to verify. */
  readonly entry: TransparencyLogEntry;
  /** A stable reference to the entry (log id + leaf index), stored as the log ref. */
  readonly logRef: string;
}

/** A pinned transparency-log public key (the `@gridmason/protocol` shape). */
export interface LogPublicKey {
  /** The checkpoint signer identity (the note key name). */
  readonly name: string;
  /** The raw 32-byte Ed25519 public key. */
  readonly key: Uint8Array;
}

/** The transparency log the countersign stage anchors releases in. */
export interface TransparencyLog {
  /** Append one leaf and return its inclusion entry. */
  append(input: LogAppendInput): Promise<LogAppendResult>;
}

const ED25519_ALG = 0x01;
const textEncoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function base64UrlToBytes(b64url: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64url, 'base64url'));
}

/** Extract the raw 32-byte Ed25519 public key from a Node KeyObject via JWK. */
function rawEd25519PublicKey(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (jwk.x === undefined) {
    throw new Error('ed25519 public key JWK is missing its x coordinate');
  }
  return base64UrlToBytes(jwk.x);
}

/** The 4-byte c2sp signed-note key id for a pinned Ed25519 key: `SHA-256(name ‖ 0x0A ‖ 0x01 ‖ pubkey)[:4]`. */
function keyId(name: string, rawPublicKey: Uint8Array): Uint8Array {
  const nameBytes = textEncoder.encode(name);
  const preimage = new Uint8Array(nameBytes.length + 2 + rawPublicKey.length);
  preimage.set(nameBytes, 0);
  preimage[nameBytes.length] = 0x0a;
  preimage[nameBytes.length + 1] = ED25519_ALG;
  preimage.set(rawPublicKey, nameBytes.length + 2);
  return new Uint8Array(createHash('sha256').update(preimage).digest()).subarray(0, 4);
}

/**
 * An in-process, append-only RFC 6962 transparency log with an Ed25519-signed
 * c2sp checkpoint. Not durable and not shared — dev + tests only — but its
 * Merkle math and checkpoint format are the real ones, so its entries verify
 * against `@gridmason/protocol`'s `verifyLogInclusion` unchanged.
 */
export class InMemoryTransparencyLog implements TransparencyLog {
  private readonly leaves: Uint8Array[] = [];
  private readonly origin: string;
  private readonly privateKey: KeyObject;
  private readonly rawPublicKey: Uint8Array;
  private readonly logId: string;
  private readonly keyIdBytes: Uint8Array;

  constructor(origin: string) {
    this.origin = origin;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.privateKey = privateKey;
    this.rawPublicKey = rawEd25519PublicKey(publicKey);
    // Log id is the hex SHA-256 of the log's public key (the protocol's convention).
    this.logId = toHex(new Uint8Array(createHash('sha256').update(this.rawPublicKey).digest()));
    this.keyIdBytes = keyId(this.origin, this.rawPublicKey);
  }

  /** The pinned log key hosts verify this log's checkpoints against. */
  publicKey(): LogPublicKey {
    return { name: this.origin, key: this.rawPublicKey };
  }

  append(input: LogAppendInput): Promise<LogAppendResult> {
    const body = input.body;
    this.leaves.push(body);
    const index = this.leaves.length - 1;
    const treeSize = this.leaves.length;

    const root = merkleRoot(this.leaves);
    const path = inclusionPath(index, this.leaves);
    const checkpoint = this.signCheckpoint(treeSize, root);

    const entry: TransparencyLogEntry = {
      logId: this.logId,
      index,
      integratedTime: Math.floor(Date.now() / 1000),
      canonicalBody: Buffer.from(body).toString('base64'),
      inclusionProof: {
        treeSize,
        rootHash: toHex(root),
        hashes: path.map(toHex),
      },
      checkpoint,
    };
    return Promise.resolve({ entry, logRef: `${this.logId}:${index}` });
  }

  /** Build and Ed25519-sign a c2sp/tlog-checkpoint signed note over the tree head. */
  private signCheckpoint(treeSize: number, root: Uint8Array): string {
    const body = `${this.origin}\n${treeSize}\n${Buffer.from(root).toString('base64')}\n`;
    const signature = new Uint8Array(nodeSign(null, textEncoder.encode(body), this.privateKey));
    const blob = new Uint8Array(this.keyIdBytes.length + signature.length);
    blob.set(this.keyIdBytes, 0);
    blob.set(signature, this.keyIdBytes.length);
    const sigLine = `— ${this.origin} ${Buffer.from(blob).toString('base64')}`;
    return `${body}\n${sigLine}\n`;
  }
}
