/**
 * Service entrypoint: load config, build the logger and server, start
 * listening, and shut down gracefully on signal.
 */
import { collectBootWarnings, loadConfig } from './config/index.js';
import {
  combineAuditSinks,
  emitAuditEvent,
  loggerAuditSink,
  setAuditSink,
} from './audit/index.js';
import { createPostgresAuditSink } from './audit/postgres-sink.js';
import { createLogger } from './logging/index.js';
import { buildServer } from './server.js';
import { createStorage } from './storage/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  // Surface risky-but-permitted configuration once at boot (e.g. a non-durable
  // transparency log). Fatal misconfigurations already threw in `loadConfig`.
  for (const warning of collectBootWarnings(config)) {
    logger.warn({ boot: true }, warning);
  }

  const storage = createStorage(config);

  // Audit events are both logged (observability) and persisted to Postgres
  // (durable record, FR-12). The DB write is best-effort and never blocks the
  // transition that produced the event.
  setAuditSink(
    combineAuditSinks(
      loggerAuditSink(logger),
      createPostgresAuditSink(storage.postgres, logger),
    ),
  );

  const app = await buildServer({ config, logger, storage });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs: config.shutdownTimeoutMs }, 'forced shutdown');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    app
      .close()
      .then(() => storage.close())
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      })
      .catch((err) => {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ host: config.host, port: config.port });
  emitAuditEvent('system', 'service.start', config.serviceName);
}

main().catch((err) => {
  // The logger may not exist yet if config parsing failed; use stderr directly.
  process.stderr.write(
    `${JSON.stringify({
      level: 'fatal',
      time: new Date().toISOString(),
      message: 'failed to start',
      error: err instanceof Error ? err.message : String(err),
    })}\n`,
  );
  process.exit(1);
});
