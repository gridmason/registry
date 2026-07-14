/**
 * Readiness registry.
 *
 * Liveness (`/healthz`) answers "is the process up?"; readiness (`/readyz`)
 * answers "can it serve traffic?" — which depends on external systems. This
 * registry is the seam later epics register those dependencies against. At the
 * skeleton stage the only dependency is storage (Postgres + object store,
 * arriving in #3), pre-registered as not-yet-ready so `/readyz` truthfully
 * reports the service cannot serve until storage lands.
 */

import { formatError } from '../errors.js';

export type ReadinessStatus = 'ready' | 'not-ready';

export interface ReadinessCheckResult {
  readonly status: ReadinessStatus;
  /** Human-readable reason, primarily for the not-ready case. */
  readonly detail?: string;
}

export type ReadinessProbe = () =>
  | ReadinessCheckResult
  | Promise<ReadinessCheckResult>;

export interface ReadinessReport {
  readonly status: ReadinessStatus;
  readonly checks: Record<string, ReadinessCheckResult>;
}

/**
 * A mutable set of named readiness probes. Aggregate readiness is `ready` only
 * when every registered probe reports `ready` (and vacuously ready when empty).
 */
export class ReadinessRegistry {
  private readonly probes = new Map<string, ReadinessProbe>();

  /** Register (or replace) a named probe. */
  register(name: string, probe: ReadinessProbe): void {
    this.probes.set(name, probe);
  }

  /** Remove a probe, e.g. once a dependency becomes permanently optional. */
  unregister(name: string): void {
    this.probes.delete(name);
  }

  /** Run every probe and fold the results into a single report. */
  async evaluate(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      [...this.probes.entries()].map(
        async ([name, probe]): Promise<[string, ReadinessCheckResult]> => {
          try {
            return [name, await probe()];
          } catch (err) {
            return [
              name,
              {
                status: 'not-ready',
                detail: formatError(err),
              },
            ];
          }
        },
      ),
    );

    const checks = Object.fromEntries(entries);
    const status: ReadinessStatus = entries.every(
      ([, result]) => result.status === 'ready',
    )
      ? 'ready'
      : 'not-ready';

    return { status, checks };
  }
}

/**
 * A registry seeded with the dependencies the service will need. The `storage`
 * probe defaults to not-ready; wiring a storage bundle into `buildServer`
 * replaces it with live `postgres` and `objectStore` probes
 * (see `registerStorageProbes`).
 */
export function createDefaultReadinessRegistry(): ReadinessRegistry {
  const registry = new ReadinessRegistry();
  registry.register('storage', () => ({
    status: 'not-ready',
    detail: 'storage layer not configured',
  }));
  return registry;
}
