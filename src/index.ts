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
import {
  createTransparencyLog,
  InMemoryTransparencyLog,
} from './sigstore/index.js';
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

  // Build the transparency log once and inject it, so the active checkpoint key
  // printed below is the exact one the countersign stage anchors with. A
  // misconfigured stable memory key throws here — a loud boot failure (#61).
  const transparencyLog = createTransparencyLog(config.transparencyLog);
  if (transparencyLog instanceof InMemoryTransparencyLog) {
    // Print the pinnable log public key so an operator can copy it straight into a
    // host's `logPublicKey` pin (and `trust-root:init` publishes it, #61).
    const pk = transparencyLog.publicKey();
    logger.info(
      {
        boot: true,
        transparencyLog: {
          driver: 'memory',
          stable: config.transparencyLog.memoryKeyDerBase64 !== '',
          publicKey: { name: pk.name, key: Buffer.from(pk.key).toString('base64') },
        },
      },
      'transparency-log public key — pin this as the host `logPublicKey` (name + base64 raw 32-byte Ed25519 key)',
    );
  } else {
    logger.info(
      { boot: true, transparencyLog: { driver: 'rekor', rekorUrl: config.transparencyLog.rekorUrl } },
      'transparency log: rekor — hosts pin the public Rekor checkpoint key out of band (docs/self-host/config.md)',
    );
  }

  // Audit events are both logged (observability) and persisted to Postgres
  // (durable record, FR-12). The DB write is best-effort and never blocks the
  // transition that produced the event.
  setAuditSink(
    combineAuditSinks(
      loggerAuditSink(logger),
      createPostgresAuditSink(storage.postgres, logger),
    ),
  );

  const app = await buildServer({ config, logger, storage, transparencyLog });

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
