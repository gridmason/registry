import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderTemplate, renderVariant, VARIANTS } from '../scripts/render-policy.ts';

const rendered = (variant: string): string =>
  readFileSync(new URL(`../docs/policy/rendered/${variant}.html`, import.meta.url), 'utf8');

// The two published variants must differ EXACTLY on the SPEC §4a launch-phase
// points: the flagship discloses the single-roster waiver, published-target
// SLAs, and countersign-key custody; the self-host variant carries none of that
// waiver language and instead affirms separation of duties is enforced.
const FLAGSHIP_ONLY = [
  'single-person review roster',
  'separation-of-duties rule is <strong>waived',
  'flagged in its transparency-log entry',
  'published targets, not guarantees',
  'invite-only',
];

describe('policy-page template engine', () => {
  it('interpolates escaped and raw values', () => {
    const out = renderTemplate('<p>{{ a }}</p><p>{{{ b }}}</p>', { a: '<x>', b: '<em>ok</em>' });
    expect(out).toBe('<p>&lt;x&gt;</p><p><em>ok</em></p>');
  });

  it('renders #if / #unless by truthiness', () => {
    const tpl = '{{#if on}}Y{{/if}}{{#unless on}}N{{/unless}}';
    expect(renderTemplate(tpl, { on: true })).toBe('Y');
    expect(renderTemplate(tpl, { on: false })).toBe('N');
    expect(renderTemplate(tpl, { on: [] })).toBe('N'); // empty array is falsy
  });

  it('renders #each over array items with item scope', () => {
    const out = renderTemplate('{{#each xs}}[{{ n }}]{{/each}}', { xs: [{ n: 1 }, { n: 2 }] });
    expect(out).toBe('[1][2]');
  });

  it('throws on an unclosed section', () => {
    expect(() => renderTemplate('{{#if a}}x', {})).toThrow(/Unclosed section/);
  });
});

describe('rendered policy pages', () => {
  it('committed rendered pages are up to date with the template + variant data', () => {
    // This is the drift guard: `npm run policy:check` and this assertion enforce
    // that the committed rendered/<v>.html were produced from the single source.
    for (const variant of VARIANTS) {
      expect(rendered(variant), `docs/policy/rendered/${variant}.html is stale`).toBe(
        renderVariant(variant),
      );
    }
  });

  it('flagship variant discloses the §4a waiver, published-target SLAs, and custody note', () => {
    const html = rendered('flagship');
    for (const phrase of FLAGSHIP_ONLY) {
      expect(html, `flagship must disclose: ${phrase}`).toContain(phrase);
    }
    expect(html).toContain('Countersign-key custody:');
    expect(html).toContain('offline key, held distinct from the reviewer');
  });

  it('self-host variant omits all waiver language and affirms enforcement', () => {
    const html = rendered('self-host');
    for (const phrase of FLAGSHIP_ONLY) {
      expect(html, `self-host must NOT carry flagship waiver language: ${phrase}`).not.toContain(
        phrase,
      );
    }
    expect(html).toContain('enforces separation of duties');
    expect(html).toContain("none of the Gridmason flagship's launch-phase waivers");
  });

  it('both variants are the same page structure from one template', () => {
    // Same section headings prove a single source, different bodies prove the
    // variant selector actually diverges the two.
    const marker = '<h2>4. Separation of duties</h2>';
    expect(rendered('flagship')).toContain(marker);
    expect(rendered('self-host')).toContain(marker);
    expect(rendered('flagship')).not.toBe(rendered('self-host'));
  });
});
