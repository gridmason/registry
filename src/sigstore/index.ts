/**
 * Transparency-log selection (SPEC §2, §4.3, GW-D17).
 *
 * Chooses the log the countersign stage anchors releases in from config: the real
 * Rekor client for production (`rekor`) or the in-process RFC 6962 log for dev and
 * tests (`memory`). Both satisfy {@link TransparencyLog}, so the stage never
 * branches on the choice.
 */
import type { TransparencyLogConfig } from '../config/index.js';
import {
  InMemoryTransparencyLog,
  loadStableMemoryKey,
  type LogPublicKey,
  type TransparencyLog,
} from './log.js';
import { RekorTransparencyLog } from './rekor.js';

export type { TransparencyLog, LogAppendInput, LogAppendResult, LogPublicKey } from './log.js';
export { InMemoryTransparencyLog, encodeLogPublicKey, loadStableMemoryKey, MemoryLogKeyError } from './log.js';
export { RekorTransparencyLog } from './rekor.js';

/**
 * Build the transparency log named by `config.driver`. The `memory` log uses the
 * stable key from `config.memoryKeyDerBase64` when set (so its checkpoints are
 * pinnable across restarts, #61), else a fresh ephemeral key; a garbage stable key
 * throws at boot (`loadStableMemoryKey`), never a silent ephemeral fallback.
 */
export function createTransparencyLog(config: TransparencyLogConfig): TransparencyLog {
  switch (config.driver) {
    case 'rekor':
      return new RekorTransparencyLog({ baseUrl: config.rekorUrl });
    case 'memory':
      return new InMemoryTransparencyLog(
        config.origin,
        config.memoryKeyDerBase64 === '' ? undefined : loadStableMemoryKey(config.memoryKeyDerBase64),
      );
  }
}

/**
 * The registry-derived, **pinnable** transparency-log public key for this config,
 * or `null` when there is none to publish: the `memory` log with a **stable** key
 * derives its checkpoint key here (for the boot line and `trust-root:init`); an
 * ephemeral `memory` log has no cross-restart key, and `rekor` mode does not
 * identify a checkpoint key in code — an operator pins the public Rekor key out of
 * band (`TRUST_ROOT_LOG_PUBLIC_KEYS`, see `docs/self-host/config.md`).
 */
export function activeStableLogPublicKey(config: TransparencyLogConfig): LogPublicKey | null {
  if (config.driver !== 'memory' || config.memoryKeyDerBase64 === '') return null;
  return new InMemoryTransparencyLog(config.origin, loadStableMemoryKey(config.memoryKeyDerBase64)).publicKey();
}
