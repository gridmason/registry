/**
 * HTTP server assembly.
 *
 * Builds the Fastify instance from an already-loaded {@link Config} and
 * {@link Logger}, wires correlation-id handling, and mounts the routes that
 * exist at the skeleton stage (health only). No publish/review/serving/
 * resolution surface is registered here — those arrive in R-E1/R-E2.
 */
import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';

import type { Config } from './config/index.js';
import { healthRoutes } from './http/health.js';
import {
  createDefaultReadinessRegistry,
  type ReadinessRegistry,
} from './http/readiness.js';
import type { Logger } from './logging/index.js';
import { registerStorageProbes, type Storage } from './storage/index.js';

export interface BuildServerOptions {
  config: Config;
  logger: Logger;
  /** Override the readiness registry (tests inject their own). */
  readiness?: ReadinessRegistry;
  /**
   * Storage bundle. When provided, its Postgres and object-store liveness
   * replace the skeleton's placeholder `storage` readiness probe.
   */
  storage?: Storage;
}

export async function buildServer(options: BuildServerOptions) {
  const { config, logger } = options;
  const readiness = options.readiness ?? createDefaultReadinessRegistry();

  if (options.storage) {
    registerStorageProbes(readiness, options.storage);
  }

  const app = Fastify({
    loggerInstance: logger,
    // Adopt a caller-supplied correlation id from the configured header; fall
    // back to a fresh UUID. Fastify binds this id to the per-request child
    // logger under `reqId`.
    requestIdHeader: config.requestIdHeader,
    genReqId: () => randomUUID(),
  });

  // Echo the correlation id back so callers can stitch client and server logs.
  app.addHook('onSend', async (request, reply) => {
    reply.header(config.requestIdHeader, request.id);
  });

  await app.register(healthRoutes, {
    readiness,
    serviceName: config.serviceName,
  });

  return app;
}
