import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/logging/index.js';
import { buildServer } from '../src/server.js';
import { ReadinessRegistry } from '../src/http/readiness.js';

const config = loadConfig({ LOG_LEVEL: 'silent' });
const logger = createLogger(config);

describe('health endpoints', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  afterEach(async () => {
    await app.close();
  });

  it('GET /healthz returns 200 with a JSON body', async () => {
    app = await buildServer({ config, logger });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'gridmason-registry' });
  });

  it('GET /readyz reports not-ready while storage is unconfigured (503)', async () => {
    app = await buildServer({ config, logger });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('not-ready');
    expect(body.checks.storage.status).toBe('not-ready');
  });

  it('GET /readyz returns 200 when every probe is ready', async () => {
    const readiness = new ReadinessRegistry();
    readiness.register('storage', () => ({ status: 'ready' }));
    app = await buildServer({ config, logger, readiness });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
  });

  it('adopts an inbound correlation id and echoes it back', async () => {
    app = await buildServer({ config, logger });
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'corr-123' },
    });
    expect(res.headers['x-request-id']).toBe('corr-123');
  });

  it('generates a correlation id when none is supplied', async () => {
    app = await buildServer({ config, logger });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('ReadinessRegistry', () => {
  it('is vacuously ready with no probes', async () => {
    const registry = new ReadinessRegistry();
    expect((await registry.evaluate()).status).toBe('ready');
  });

  it('is not-ready if any probe fails', async () => {
    const registry = new ReadinessRegistry();
    registry.register('a', () => ({ status: 'ready' }));
    registry.register('b', () => ({ status: 'not-ready' }));
    const report = await registry.evaluate();
    expect(report.status).toBe('not-ready');
  });

  it('treats a throwing probe as not-ready', async () => {
    const registry = new ReadinessRegistry();
    registry.register('boom', () => {
      throw new Error('connection refused');
    });
    const report = await registry.evaluate();
    expect(report.status).toBe('not-ready');
    expect(report.checks.boom?.detail).toBe('connection refused');
  });
});
