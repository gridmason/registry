/**
 * Service entrypoint: load config, build the logger and server, start
 * listening, and shut down gracefully on signal.
 */
import { loadConfig } from './config/index.js';
import { emitAuditEvent, loggerAuditSink, setAuditSink } from './audit/index.js';
import { createLogger } from './logging/index.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  // Route audit events to the structured log until a durable sink lands (#3).
  setAuditSink(loggerAuditSink(logger));

  const app = await buildServer({ config, logger });

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
