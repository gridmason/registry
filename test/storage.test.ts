import { describe, expect, it } from 'vitest';

import { ReadinessRegistry } from '../src/http/readiness.js';
import type { Postgres } from '../src/db/postgres.js';
import {
  InMemoryObjectStore,
  registerStorageProbes,
  type Storage,
} from '../src/storage/index.js';

/** A Postgres double whose `ping` resolves or rejects on demand. */
function fakePostgres(pingResult: 'ok' | Error): Postgres {
  return {
    query: () => Promise.resolve({ rows: [] } as never),
    withClient: (fn) => fn({ query: () => Promise.resolve({ rows: [] }) }),
    ping: () => (pingResult === 'ok' ? Promise.resolve() : Promise.reject(pingResult)),
    close: () => Promise.resolve(),
  };
}

function storageWith(pingResult: 'ok' | Error): Storage {
  return {
    postgres: fakePostgres(pingResult),
    objectStore: new InMemoryObjectStore(),
    close: () => Promise.resolve(),
  };
}

describe('registerStorageProbes', () => {
  it('replaces the placeholder probe with per-store probes', async () => {
    const readiness = new ReadinessRegistry();
    readiness.register('storage', () => ({ status: 'not-ready' }));

    registerStorageProbes(readiness, storageWith('ok'));
    const report = await readiness.evaluate();

    expect(report.status).toBe('ready');
    expect(Object.keys(report.checks).sort()).toEqual(['objectStore', 'postgres']);
    expect(report.checks.storage).toBeUndefined();
  });

  it('reports not-ready with the error detail when Postgres is down', async () => {
    const readiness = new ReadinessRegistry();
    registerStorageProbes(readiness, storageWith(new Error('connection refused')));

    const report = await readiness.evaluate();
    expect(report.status).toBe('not-ready');
    expect(report.checks.postgres?.status).toBe('not-ready');
    expect(report.checks.postgres?.detail).toBe('connection refused');
    expect(report.checks.objectStore?.status).toBe('ready');
  });
});
