import { describe, expect, it, vi } from 'vitest';

import { emitAuditEvent, setAuditSink, noopAuditSink } from '../src/audit/index.js';
import { createPostgresAuditSink } from '../src/audit/postgres-sink.js';
import type { Postgres } from '../src/db/postgres.js';
import type { Logger } from '../src/logging/index.js';

function fakePostgres(query: Postgres['query']): Postgres {
  return {
    query,
    withClient: (fn) => fn({ query: () => Promise.resolve({ rows: [] }) }),
    ping: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

const silentLogger = { error: vi.fn(), info: vi.fn() } as unknown as Logger;

describe('createPostgresAuditSink', () => {
  it('inserts an emitted event into audit_event', () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] } as never));
    const sink = createPostgresAuditSink(fakePostgres(query), silentLogger);
    setAuditSink(sink);

    const at = new Date('2026-07-14T00:00:00.000Z');
    emitAuditEvent('publisher-1', 'publish', 'acme#clock', at);
    setAuditSink(noopAuditSink);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_event'), [
      'publisher-1',
      'publish',
      'acme#clock',
      at,
    ]);
  });

  it('logs and swallows a persistence failure without throwing', async () => {
    const error = vi.fn();
    const logger = { error, info: vi.fn() } as unknown as Logger;
    const query = vi.fn(() => Promise.reject(new Error('db down')));
    const sink = createPostgresAuditSink(fakePostgres(query as never), logger);

    expect(() => sink.emit({ actor: 'a', action: 'b', subject: 'c', at: new Date() })).not.toThrow();
    // let the fire-and-forget rejection settle
    await Promise.resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'b' }),
      'failed to persist audit event',
    );
  });
});
