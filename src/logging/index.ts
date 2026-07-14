/**
 * Structured logging.
 *
 * One JSON object per line, always carrying `level` (as a label), `time` (ISO
 * 8601), `message`, and `service`. Per-request child loggers additionally bind
 * the correlation id under `reqId` (wired in `src/server.ts`). pino is the
 * logger of record: it is Fastify's native logger, so request logging and
 * application logging share one instance and one format.
 */
import { pino, type Logger } from 'pino';

import type { Config } from '../config/index.js';

export type { Logger };

/**
 * Create the root logger. The `message`/`level`/`time` key shapes are pinned
 * here so downstream consumers (and CI log assertions) can rely on them.
 */
export function createLogger(config: Config): Logger {
  return pino({
    level: config.logLevel,
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: config.serviceName },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}
