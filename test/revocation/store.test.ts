/**
 * FeedEntry store (#14, FR-8): the in-memory store's monotonic `seq` and snapshot
 * semantics. The Postgres store enforces the same invariant with a
 * `GENERATED ALWAYS AS IDENTITY` column (migration 0001); this exercises the
 * in-memory mirror the API tests and hosts run against.
 */
import { describe, expect, it } from 'vitest';

import { InMemoryFeedEntryStore } from '../../src/revocation/store.js';

describe('InMemoryFeedEntryStore', () => {
  it('assigns a strictly monotonic seq across appends', async () => {
    const store = new InMemoryFeedEntryStore();
    const a = await store.append({
      artifactId: 'art-1',
      artifact: 'acme-clock@1.0.0',
      state: 'revoked',
      severity: 'medium',
      reason: 'superseded',
    });
    const b = await store.append({
      artifactId: 'art-2',
      artifact: 'acme-chart@2.0.0',
      state: 'killed',
      severity: 'critical',
      reason: 'actively exploited',
    });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it('reports an empty feed as seq 0 with no entries', async () => {
    const store = new InMemoryFeedEntryStore();
    const snapshot = await store.snapshot();
    expect(snapshot).toEqual({ seq: 0, entries: [] });
  });

  it('snapshots the latest entry per artifact and the global max seq', async () => {
    const store = new InMemoryFeedEntryStore();
    await store.append({
      artifactId: 'art-1',
      artifact: 'acme-clock@1.0.0',
      state: 'revoked',
      severity: 'low',
      reason: 'deprecated',
    });
    await store.append({
      artifactId: 'art-2',
      artifact: 'acme-chart@2.0.0',
      state: 'revoked',
      severity: 'medium',
      reason: 'bug',
    });
    // Escalate art-1 revoked → killed: a new row with a higher seq.
    await store.append({
      artifactId: 'art-1',
      artifact: 'acme-clock@1.0.0',
      state: 'killed',
      severity: 'critical',
      reason: 'credential path',
    });

    const snapshot = await store.snapshot();
    // Feed version is the global max seq (the escalation row).
    expect(snapshot.seq).toBe(3);
    // One entry per artifact, latest state, in seq order.
    expect(snapshot.entries).toEqual([
      { seq: 2, artifact: 'acme-chart@2.0.0', state: 'revoked', severity: 'medium', reason: 'bug' },
      { seq: 3, artifact: 'acme-clock@1.0.0', state: 'killed', severity: 'critical', reason: 'credential path' },
    ]);
  });
});
