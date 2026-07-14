/**
 * The automated-review fixture suite — the same manifest/source cases a
 * `gridmason lint` fixture set covers, used here to prove the registry's
 * automated review produces byte-identical shared-checks output (FR-3, SPEC §9).
 *
 * These are **vendored** locally because `@gridmason/cli@0.0.3` does not yet ship
 * its lint fixtures as a consumable export; when it does, this suite should be
 * replaced by that shared set so the equivalence is asserted against the CLI's
 * own fixtures rather than a parallel copy (flagged for the PM in the PR).
 */
import type { SourceFile } from '@gridmason/cli/checks';

import type { ArtifactFile } from '../../src/artifact/upload.js';

export interface ReviewFixture {
  readonly name: string;
  /** The manifest under review (a JSON-safe object). */
  readonly manifest: unknown;
  /** Optional widget source the static-analysis checks read. */
  readonly sourceFiles?: readonly SourceFile[];
  /** Whether the shared checks fail this fixture (drives the `rejected` assertion). */
  readonly expectFail: boolean;
}

/** A schema-valid, publisher-prefixed manifest the clean fixtures build on. */
const validManifest = {
  formatVersion: '1.0',
  tag: 'acme-clock',
  kind: 'widget',
  name: 'Acme Clock',
  publisher: 'acme',
  version: '1.2.0',
  entry: 'entry.js',
};

export const reviewFixtures: readonly ReviewFixture[] = [
  { name: 'clean manifest', manifest: validManifest, expectFail: false },
  {
    name: 'clean manifest with benign source',
    manifest: validManifest,
    sourceFiles: [{ path: 'entry.js', contents: 'export default class extends HTMLElement {}\n' }],
    expectFail: false,
  },
  {
    // Missing the required `entry` field → manifest.schema fails.
    name: 'schema: missing required field',
    manifest: {
      formatVersion: '1.0',
      tag: 'acme-clock',
      kind: 'widget',
      name: 'Acme Clock',
      publisher: 'acme',
      version: '1.2.0',
    },
    expectFail: true,
  },
  {
    // Well-formed tag that is not under the manifest's publisher prefix →
    // manifest.tag fails (the publisher-prefix rule, SPEC §5).
    name: 'tag not publisher-prefixed',
    manifest: { ...validManifest, tag: 'other-clock' },
    expectFail: true,
  },
  {
    // Empty scope segment → manifest.capabilities fails.
    name: 'capability with empty scope segment',
    manifest: { ...validManifest, capabilities: [{ api: 'net', scope: 'a::b' }] },
    expectFail: true,
  },
  {
    // A widget that requires its own tag → deps.acyclic fails (circular requires,
    // SPEC §7). This is the offline-detectable cycle the registry rejects.
    name: 'self-referential requires (cycle)',
    manifest: { ...validManifest, requires: [{ tag: 'acme-clock', range: '^1.0.0' }] },
    expectFail: true,
  },
];

/** The circular-`requires` fixture the rejection tests key on. */
export const circularRequiresFixture: ReviewFixture = reviewFixtures.find((f) =>
  f.name.includes('cycle'),
)!;

/** A clean fixture the pass-path tests key on. */
export const cleanFixture: ReviewFixture = reviewFixtures[0]!;

/**
 * Render a fixture as the uploaded artifact parts the review stage consumes: the
 * manifest part, plus each source file as a served `entry`/`chunk` part (with a
 * source-extension path, so the stage picks them up as `sourceFiles` exactly as
 * it would from a real upload).
 */
export function filesForFixture(fixture: ReviewFixture): ArtifactFile[] {
  const encode = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));
  const files: ArtifactFile[] = [
    { path: 'manifest.json', role: 'manifest', bytes: encode(JSON.stringify(fixture.manifest)) },
  ];
  (fixture.sourceFiles ?? []).forEach((source, index) => {
    files.push({
      path: source.path,
      role: index === 0 ? 'entry' : 'chunk',
      bytes: encode(source.contents),
    });
  });
  return files;
}
