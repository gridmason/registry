/**
 * Storage bundle: the Postgres handle and the object store the service depends
 * on, plus the wiring that turns their liveness into `/readyz` probes.
 */
import type { Config } from '../config/index.js';
import { createPostgres, type Postgres } from '../db/postgres.js';
import type { ReadinessRegistry } from '../http/readiness.js';
import { createS3ObjectStore, type ObjectStore } from './object-store.js';

export type { ObjectStore } from './object-store.js';
export { InMemoryObjectStore, createS3ObjectStore } from './object-store.js';
export type { Postgres } from '../db/postgres.js';

export interface Storage {
  readonly postgres: Postgres;
  readonly objectStore: ObjectStore;
  /** Close both stores; settles all closes even if one rejects. */
  close(): Promise<void>;
}

/** Build the production storage bundle (real Postgres + S3) from config. */
export function createStorage(config: Config): Storage {
  const postgres = createPostgres(config.postgres);
  const objectStore = createS3ObjectStore(config.objectStore);
  return {
    postgres,
    objectStore,
    async close() {
      await Promise.allSettled([postgres.close(), objectStore.close()]);
    },
  };
}

/**
 * Replace the skeleton's placeholder `storage` probe with live per-store probes.
 * A store is `ready` when its `ping` resolves; a thrown/ rejected ping is folded
 * to `not-ready` with the error message by the {@link ReadinessRegistry}.
 */
export function registerStorageProbes(
  readiness: ReadinessRegistry,
  storage: Storage,
): void {
  readiness.unregister('storage');
  readiness.register('postgres', async () => {
    await storage.postgres.ping();
    return { status: 'ready' };
  });
  readiness.register('objectStore', async () => {
    await storage.objectStore.ping();
    return { status: 'ready' };
  });
}
