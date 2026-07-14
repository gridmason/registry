/**
 * Migration entrypoint — `npm run migrate` (dev) or `node dist/db/migrate-cli.js`
 * (container). Kept a dedicated command rather than a boot-time side effect so
 * schema changes never apply implicitly on service start.
 */
import { loadConfig } from '../config/index.js';
import { formatError } from '../errors.js';
import { createLogger } from '../logging/index.js';
import { runMigrations } from './migrate.js';
import { createPostgres } from './postgres.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const postgres = createPostgres(config.postgres);

  try {
    const applied = await postgres.withClient((client) =>
      runMigrations(client, { logger }),
    );
    logger.info({ applied, count: applied.length }, 'migrations complete');
  } finally {
    await postgres.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'fatal',
      time: new Date().toISOString(),
      message: 'migration failed',
      error: formatError(err),
    })}\n`,
  );
  process.exit(1);
});
