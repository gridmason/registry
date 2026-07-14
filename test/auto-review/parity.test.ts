/**
 * Shared-code proof (FR-3, SPEC §9): the automated-review stage runs the
 * **identical** `@gridmason/cli/checks` code path `gridmason lint` runs, so for
 * the same manifest/source its findings are byte-for-byte what the CLI computes.
 *
 * For every fixture, the report the stage builds from the uploaded artifact parts
 * must deep-equal `runChecks` called directly on the equivalent context — proving
 * both that no check is reimplemented and that the stage's context-building
 * (manifest parse + served-source mapping) feeds the shared checks the same input
 * the CLI does.
 */
import { hasFailure, runChecks } from '@gridmason/cli/checks';
import { describe, expect, it } from 'vitest';

import { buildAutomatedReviewReport, CHECKS_MODULE } from '../../src/review/report.js';
import { filesForFixture, reviewFixtures } from './fixtures.js';

describe('automated review — shared-checks parity', () => {
  it.each(reviewFixtures.map((fixture) => [fixture.name, fixture] as const))(
    'reproduces the shared-checks report byte-for-byte: %s',
    (_name, fixture) => {
      const report = buildAutomatedReviewReport(filesForFixture(fixture));
      const expected = runChecks({
        manifest: fixture.manifest,
        sourceFiles: fixture.sourceFiles ?? [],
      });

      expect(report.results).toEqual(expected);
      expect(report.status).toBe(hasFailure(expected) ? 'fail' : 'pass');
      expect(report.status === 'fail').toBe(fixture.expectFail);
      expect(report.checksModule).toBe(CHECKS_MODULE);
    },
  );

  it('flags the self-referential requires fixture as a dependency cycle', () => {
    const report = buildAutomatedReviewReport(
      filesForFixture(reviewFixtures.find((f) => f.name.includes('cycle'))!),
    );
    expect(report.status).toBe('fail');
    expect(report.results).toContainEqual(
      expect.objectContaining({ id: 'deps.acyclic', status: 'fail' }),
    );
  });
});
