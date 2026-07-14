/**
 * Audit query store unit paths (#15): the limit clamp and the keyset-cursor
 * contract that the HTTP layer and the Postgres store both rely on.
 */
import { describe, expect, it } from 'vitest';

import {
  AUDIT_QUERY_DEFAULT_LIMIT,
  AUDIT_QUERY_MAX_LIMIT,
  clampAuditLimit,
  InMemoryAuditStore,
} from '../../src/audit/query.js';

describe('clampAuditLimit', () => {
  it('defaults an unset or non-finite limit', () => {
    expect(clampAuditLimit(undefined)).toBe(AUDIT_QUERY_DEFAULT_LIMIT);
    expect(clampAuditLimit(Number.NaN)).toBe(AUDIT_QUERY_DEFAULT_LIMIT);
  });

  it('floors, and clamps into [1, MAX]', () => {
    expect(clampAuditLimit(0)).toBe(1);
    expect(clampAuditLimit(-5)).toBe(1);
    expect(clampAuditLimit(2.9)).toBe(2);
    expect(clampAuditLimit(AUDIT_QUERY_MAX_LIMIT + 100)).toBe(AUDIT_QUERY_MAX_LIMIT);
  });
});

describe('InMemoryAuditStore', () => {
  function seed(n: number): InMemoryAuditStore {
    const store = new InMemoryAuditStore();
    for (let i = 0; i < n; i++) {
      store.emit({ actor: 'a', action: 'x', subject: `s-${i}`, at: new Date(2026, 0, i + 1) });
    }
    return store;
  }

  it('returns newest-first and sets nextBefore only on a full page', async () => {
    const store = seed(3);
    const full = await store.query({ limit: 3 });
    expect(full.events.map((e) => e.subject)).toEqual(['s-2', 's-1', 's-0']);
    // A full page (3 of 3) still advertises a cursor; the next page proves the end.
    expect(full.nextBefore).toBe(full.events[2]!.id);

    const next = await store.query({ limit: 3, before: full.nextBefore! });
    expect(next.events).toEqual([]);
    expect(next.nextBefore).toBeNull();
  });

  it('a short page closes the cursor', async () => {
    const store = seed(2);
    const page = await store.query({ limit: 10 });
    expect(page.events).toHaveLength(2);
    expect(page.nextBefore).toBeNull();
  });

  it('AND-combines subject, action, and time filters', async () => {
    const store = new InMemoryAuditStore();
    store.emit({ actor: 'a', action: 'publish', subject: 'w-1', at: new Date('2026-01-01') });
    store.emit({ actor: 'a', action: 'revoke', subject: 'w-1', at: new Date('2026-06-01') });
    store.emit({ actor: 'a', action: 'publish', subject: 'w-2', at: new Date('2026-06-01') });

    const page = await store.query({
      subject: 'w-1',
      action: 'revoke',
      since: new Date('2026-03-01'),
    });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ subject: 'w-1', action: 'revoke' });
  });
});
