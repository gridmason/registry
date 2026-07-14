/**
 * Health endpoints.
 *
 * - `GET /healthz` — liveness. 200 whenever the process is up and serving.
 * - `GET /readyz`  — readiness. 200 only when every readiness probe passes,
 *   503 otherwise (with the failing checks in the body).
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import type { ReadinessRegistry } from './readiness.js';

interface HealthPluginOptions extends FastifyPluginOptions {
  readiness: ReadinessRegistry;
  serviceName: string;
}

export async function healthRoutes(
  app: FastifyInstance,
  options: HealthPluginOptions,
): Promise<void> {
  const { readiness, serviceName } = options;

  app.get('/healthz', async () => {
    return { status: 'ok', service: serviceName };
  });

  app.get('/readyz', async (_request, reply) => {
    const report = await readiness.evaluate();
    reply.code(report.status === 'ready' ? 200 : 503);
    return { status: report.status, service: serviceName, checks: report.checks };
  });
}
