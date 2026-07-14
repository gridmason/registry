/**
 * ReviewCaseStore verdict path (#9): recordVerdict is single-shot (the
 * `verdict IS NULL` guard) and findById round-trips the case. Runs against the
 * in-memory store, which mirrors the Postgres guard.
 */
import { describe, expect, it } from 'vitest';

import type { AutomatedReviewReport } from '../../../src/review/report.js';
import { InMemoryReviewCaseStore } from '../../../src/review/store.js';

const report: AutomatedReviewReport = {
  checksModule: '@gridmason/cli/checks',
  checksVersion: '0.0.3',
  status: 'pass',
  results: [{ id: 'manifest.schema', status: 'pass', message: 'ok' }],
};

describe('InMemoryReviewCaseStore verdict path', () => {
  it('opens a case pending (no verdict) and finds it by id', async () => {
    const store = new InMemoryReviewCaseStore();
    const created = await store.create({ artifactId: 'art-1', checksReport: report });
    expect(created.verdict).toBeNull();
    expect(created.waiverUsed).toBe(false);
    expect(created.decidedAt).toBeNull();
    expect(await store.findById(created.id)).toEqual(created);
  });

  it('records a verdict once and refuses a second (single-shot guard)', async () => {
    const store = new InMemoryReviewCaseStore();
    const created = await store.create({ artifactId: 'art-1', checksReport: report });

    const decided = await store.recordVerdict({
      caseId: created.id,
      reviewer: 'issuer sub',
      verdict: 'approved',
      findings: [{ checkId: 'manual', detail: 'ok' }],
      waiverUsed: true,
    });
    expect(decided).toMatchObject({
      verdict: 'approved',
      reviewer: 'issuer sub',
      waiverUsed: true,
    });
    expect(decided?.decidedAt).toBeInstanceOf(Date);

    // A second verdict is a no-op: the first reviewer to decide wins.
    const second = await store.recordVerdict({
      caseId: created.id,
      reviewer: 'other other',
      verdict: 'rejected',
      findings: [],
      waiverUsed: false,
    });
    expect(second).toBeNull();
    expect((await store.findById(created.id))?.verdict).toBe('approved');
  });

  it('returns null recording a verdict on an unknown case', async () => {
    const store = new InMemoryReviewCaseStore();
    const result = await store.recordVerdict({
      caseId: 'nope',
      reviewer: 'issuer sub',
      verdict: 'approved',
      findings: [],
      waiverUsed: false,
    });
    expect(result).toBeNull();
  });
});
