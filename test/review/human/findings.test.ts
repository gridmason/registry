/**
 * Findings validation (FR-4: findings map to check ids). Unit-level checks over
 * {@link validateFindings} against a synthetic report.
 */
import { describe, expect, it } from 'vitest';

import type { AutomatedReviewReport } from '../../../src/review/report.js';
import { validateFindings, reportCheckIds } from '../../../src/review/human/findings.js';

const report: AutomatedReviewReport = {
  checksModule: '@gridmason/cli/checks',
  checksVersion: '0.6.0',
  status: 'pass',
  results: [
    { id: 'manifest.schema', status: 'pass', message: 'ok' },
    { id: 'sdk.raw-network', status: 'pass', message: 'ok' },
  ],
};

describe('reportCheckIds', () => {
  it('is the report ids plus the `manual` sentinel', () => {
    expect([...reportCheckIds(report)].sort()).toEqual(
      ['manifest.schema', 'manual', 'sdk.raw-network'],
    );
  });
});

describe('validateFindings', () => {
  it('treats an absent findings value as an empty list', () => {
    const result = validateFindings(undefined, report);
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it('accepts findings that reference report check ids or `manual`', () => {
    const result = validateFindings(
      [
        { checkId: 'manifest.schema', detail: 'clean' },
        { checkId: 'manual', detail: 'hand-checked' },
      ],
      report,
    );
    expect(result).toEqual({
      ok: true,
      findings: [
        { checkId: 'manifest.schema', detail: 'clean' },
        { checkId: 'manual', detail: 'hand-checked' },
      ],
    });
  });

  it('rejects a finding referencing an unknown check id', () => {
    const result = validateFindings([{ checkId: 'sdk.nope', detail: 'x' }], report);
    expect(result).toMatchObject({ ok: false, code: 'unknown-check-id' });
  });

  it('rejects a non-array findings value', () => {
    expect(validateFindings({}, report)).toMatchObject({ ok: false, code: 'not-an-array' });
  });

  it('rejects a finding missing a check id or detail', () => {
    expect(validateFindings([{ detail: 'x' }], report)).toMatchObject({
      ok: false,
      code: 'malformed-finding',
    });
    expect(validateFindings([{ checkId: 'manual' }], report)).toMatchObject({
      ok: false,
      code: 'malformed-finding',
    });
  });

  it('validates only against `manual` when the report carried a load failure', () => {
    const failed: AutomatedReviewReport = {
      checksModule: '@gridmason/cli/checks',
      checksVersion: '0.6.0',
      status: 'fail',
      results: [],
      error: { code: 'no-manifest', message: 'artifact has no manifest part' },
    };
    expect(validateFindings([{ checkId: 'manual', detail: 'x' }], failed)).toMatchObject({
      ok: true,
    });
    expect(validateFindings([{ checkId: 'manifest.schema', detail: 'x' }], failed)).toMatchObject({
      ok: false,
      code: 'unknown-check-id',
    });
  });
});
