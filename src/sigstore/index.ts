/**
 * Transparency-log selection (SPEC §2, §4.3, GW-D17).
 *
 * Chooses the log the countersign stage anchors releases in from config: the real
 * Rekor client for production (`rekor`) or the in-process RFC 6962 log for dev and
 * tests (`memory`). Both satisfy {@link TransparencyLog}, so the stage never
 * branches on the choice.
 */
import type { TransparencyLogConfig } from '../config/index.js';
import { InMemoryTransparencyLog, type TransparencyLog } from './log.js';
import { RekorTransparencyLog } from './rekor.js';

export type { TransparencyLog, LogAppendInput, LogAppendResult, LogPublicKey } from './log.js';
export { InMemoryTransparencyLog } from './log.js';
export { RekorTransparencyLog } from './rekor.js';

/** Build the transparency log named by `config.driver`. */
export function createTransparencyLog(config: TransparencyLogConfig): TransparencyLog {
  switch (config.driver) {
    case 'rekor':
      return new RekorTransparencyLog({ baseUrl: config.rekorUrl });
    case 'memory':
      return new InMemoryTransparencyLog(config.origin);
  }
}
