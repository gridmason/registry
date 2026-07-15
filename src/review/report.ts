/**
 * The automated-review report — the output of running the **shared** checks
 * module (`@gridmason/cli/checks`) over an uploaded artifact (FR-3; SPEC §4, §7,
 * §9).
 *
 * The whole point of FR-3 / SPEC §9 is *zero divergence* between what
 * `gridmason lint` reports locally and what the registry's automated review
 * reports at publish: both call the **same** {@link runChecks} on an equivalent
 * {@link CheckContext}. This module therefore reimplements **no** check — it only
 * builds the context from the uploaded artifact files (the manifest + the served
 * source the registry can statically analyse) exactly the way `gridmason lint`
 * builds it from disk, runs the shared checks, and shapes the persistable report.
 * `local-green predicts review-pass` holds by construction.
 */
import { extname } from 'node:path';

import { hasFailure, runChecks, type CheckResult } from '@gridmason/cli/checks';

import type { ArtifactFile } from '../artifact/upload.js';

/** The shared checks module the registry imports verbatim (SPEC §8, §9). */
export const CHECKS_MODULE = '@gridmason/cli/checks';

/**
 * The pinned `@gridmason/cli` version whose `./checks` export produced a report.
 * Recorded on every report for provenance and **must** track the `@gridmason/cli`
 * dependency range in `package.json` — a mismatch means the doc/report claims a
 * version the service does not actually run.
 */
export const CHECKS_VERSION = '0.6.0';

/**
 * Extensions the static-analysis checks (SDK-adherence, DOM-abuse) treat as
 * widget source, mirroring `gridmason lint`'s own set so the registry feeds the
 * shared checks the same class of input the CLI does.
 */
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

/** A load failure that stopped the checks from running at all. */
export interface AutomatedReviewError {
  /** `no-manifest` (no manifest part) or `invalid-json` (manifest is not JSON). */
  readonly code: 'no-manifest' | 'invalid-json';
  readonly message: string;
}

/**
 * The persistable automated-review report (`ReviewCase.checksReport`). `results`
 * is the **verbatim** {@link runChecks} output — the shared-code proof — so it is
 * byte-identical to what `gridmason lint` computes for the same manifest/source.
 * A load failure (unparseable/absent manifest) yields `status: 'fail'`, empty
 * `results`, and an `error`, mirroring the CLI's load-error report variant.
 */
export interface AutomatedReviewReport {
  /** The shared module the results came from (`@gridmason/cli/checks`). */
  readonly checksModule: string;
  /** The pinned `@gridmason/cli` version. */
  readonly checksVersion: string;
  /** `fail` iff a check failed (or the manifest could not be loaded). */
  readonly status: 'pass' | 'fail';
  /** Verbatim shared-checks findings, in check order; empty on a load failure. */
  readonly results: readonly CheckResult[];
  /** Present only when a load failure stopped the checks from running. */
  readonly error?: AutomatedReviewError;
}

function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

function loadFailure(error: AutomatedReviewError): AutomatedReviewReport {
  return {
    checksModule: CHECKS_MODULE,
    checksVersion: CHECKS_VERSION,
    status: 'fail',
    results: [],
    error,
  };
}

/**
 * Build the automated-review report for an uploaded artifact by running the
 * shared checks over it. The manifest is the artifact's `manifest` part parsed as
 * JSON; the source files are its served `entry` + `chunk` parts with a source
 * extension (the registry's analogue of the on-disk source `gridmason lint`
 * walks). `registry` is deliberately left unset: the registry-aware checks
 * (capability-diff, transitive-DAG) are later phases, so only the offline shared
 * surface runs here.
 */
export function buildAutomatedReviewReport(
  files: readonly ArtifactFile[],
): AutomatedReviewReport {
  const manifestFile = files.find((f) => f.role === 'manifest');
  // Intake (parseArtifactUpload) guarantees exactly one manifest; treat its
  // absence as a hard load failure rather than throwing, so the stage always
  // yields a persistable verdict.
  if (!manifestFile) {
    return loadFailure({ code: 'no-manifest', message: 'artifact has no manifest part' });
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(decodeUtf8(manifestFile.bytes));
  } catch (err) {
    return loadFailure({
      code: 'invalid-json',
      message: `manifest is not valid JSON: ${(err as Error).message}`,
    });
  }

  const sourceFiles = files
    .filter(
      (f) =>
        (f.role === 'entry' || f.role === 'chunk') &&
        SOURCE_EXTENSIONS.has(extname(f.path)),
    )
    .map((f) => ({ path: f.path, contents: decodeUtf8(f.bytes) }));

  const results = runChecks({ manifest, sourceFiles });
  return {
    checksModule: CHECKS_MODULE,
    checksVersion: CHECKS_VERSION,
    status: hasFailure(results) ? 'fail' : 'pass',
    results,
  };
}
