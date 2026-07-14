/**
 * Policy-page renderer.
 *
 * Renders the single policy-page template (`docs/policy/policy-page.template.html`)
 * into one deterministic HTML page per operator variant, using that variant's
 * data file (`docs/policy/variants/<variant>.json`). Two variants ship:
 *
 *   - `flagship`  — the invite-only launch instance (registry.gridmason.dev):
 *                   discloses the single-roster separation-of-duties waiver,
 *                   published-target (not guaranteed) SLAs, and the countersign
 *                   -key custody note per SPEC §4a.
 *   - `self-host` — the neutral default every self-hosted instance starts from:
 *                   separation of duties enforced, no launch-phase waivers,
 *                   operator fills in its own policy.
 *
 * The renderer is intentionally dependency-free (a tiny Mustache-lite engine)
 * so the template lives in-repo with no build toolchain of its own. It is a
 * docs/ops helper: it is not part of the running service and is not shipped in
 * the container image (the build compiles `src/` only).
 *
 * Usage (via `tsx`, wired to npm scripts):
 *   npm run policy:render          # render every variant, write rendered/<v>.html
 *   npm run policy:render -- --variant flagship --stdout
 *   npm run policy:check           # render + assert committed outputs are current
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const VARIANTS = ['flagship', 'self-host'] as const;
export type Variant = (typeof VARIANTS)[number];

const TEMPLATE_URL = new URL('../docs/policy/policy-page.template.html', import.meta.url);
const variantDataUrl = (variant: string): URL =>
  new URL(`../docs/policy/variants/${variant}.json`, import.meta.url);
const renderedUrl = (variant: string): URL =>
  new URL(`../docs/policy/rendered/${variant}.html`, import.meta.url);

// --- Mustache-lite template engine -----------------------------------------
//
// Supported syntax (only what the template uses, kept minimal on purpose):
//   {{ path }}            HTML-escaped interpolation
//   {{{ path }}}          raw (unescaped) interpolation
//   {{! comment }}        dropped
//   {{#if path}}…{{/if}}          render body when path is truthy
//   {{#unless path}}…{{/unless}}  render body when path is falsy
//   {{#each path}}…{{/each}}      render body once per array item (item = scope)
//
// Path resolution reads from the current scope, falling back to the root scope;
// `.`/`this` is the current scope and `@root.x` forces a root lookup. Truthiness
// treats null/undefined/false/''/0/NaN and empty arrays as falsy.

type TextNode = { kind: 'text'; value: string };
type VarNode = { kind: 'var'; path: string; raw: boolean };
type SectionType = 'if' | 'unless' | 'each';
type SectionNode = { kind: 'section'; type: SectionType; path: string; body: Node[] };
type Node = TextNode | VarNode | SectionNode;

const TOKEN_RE = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([^}]+?)\s*\}\}/g;

export function parseTemplate(src: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{ type: SectionType; parent: Node[] }> = [];
  let current = root;
  let last = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(src)) !== null) {
    if (match.index > last) {
      current.push({ kind: 'text', value: src.slice(last, match.index) });
    }
    last = TOKEN_RE.lastIndex;

    const rawVar = match[1];
    if (rawVar !== undefined) {
      current.push({ kind: 'var', path: rawVar, raw: true });
      continue;
    }

    const inner = (match[2] ?? '').trim();
    if (inner.startsWith('!')) continue; // comment
    if (inner.startsWith('#')) {
      const opened = /^#(if|unless|each)\s+(.+)$/.exec(inner);
      if (!opened) throw new Error(`Malformed section tag: {{${inner}}}`);
      const type = opened[1] as SectionType;
      const node: SectionNode = { kind: 'section', type, path: opened[2]!.trim(), body: [] };
      current.push(node);
      stack.push({ type, parent: current });
      current = node.body;
    } else if (inner.startsWith('/')) {
      const type = inner.slice(1).trim();
      const open = stack.pop();
      if (!open || open.type !== type) {
        throw new Error(`Mismatched closing tag: {{${inner}}}`);
      }
      current = open.parent;
    } else {
      current.push({ kind: 'var', path: inner, raw: false });
    }
  }
  if (last < src.length) current.push({ kind: 'text', value: src.slice(last) });
  if (stack.length) throw new Error(`Unclosed section: {{#${stack[stack.length - 1]!.type}}}`);
  return root;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolvePath(path: string, scope: unknown, root: unknown): unknown {
  if (path === '.' || path === 'this') return scope;
  let base = scope;
  let rest = path;
  if (path.startsWith('@root.')) {
    base = root;
    rest = path.slice('@root.'.length);
  }
  const walk = (from: unknown): unknown => {
    let value = from;
    for (const part of rest.split('.')) {
      if (!isObject(value)) return undefined;
      value = value[part];
    }
    return value;
  };
  const found = walk(base);
  if (found === undefined && base !== root) return walk(root);
  return found;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function renderNodes(nodes: Node[], scope: unknown, root: unknown): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.value;
    } else if (node.kind === 'var') {
      const value = resolvePath(node.path, scope, root);
      if (value === undefined || value === null) continue;
      out += node.raw ? String(value) : escapeHtml(String(value));
    } else {
      const value = resolvePath(node.path, scope, root);
      if (node.type === 'if' && truthy(value)) {
        out += renderNodes(node.body, scope, root);
      } else if (node.type === 'unless' && !truthy(value)) {
        out += renderNodes(node.body, scope, root);
      } else if (node.type === 'each' && Array.isArray(value)) {
        for (const item of value) out += renderNodes(node.body, item, root);
      }
    }
  }
  return out;
}

export function renderTemplate(source: string, data: unknown): string {
  return renderNodes(parseTemplate(source), data, data);
}

/** Read the template + a variant's data file and produce its rendered page. */
export function renderVariant(variant: string): string {
  const template = readFileSync(TEMPLATE_URL, 'utf8');
  const data = JSON.parse(readFileSync(variantDataUrl(variant), 'utf8')) as unknown;
  return renderTemplate(template, data);
}

// --- CLI --------------------------------------------------------------------

function isEntrypoint(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

function main(argv: string[]): number {
  const check = argv.includes('--check');
  const toStdout = argv.includes('--stdout');
  const only = argv[argv.indexOf('--variant') + 1];
  const selected =
    argv.includes('--variant') && only && VARIANTS.includes(only as Variant) ? [only] : [...VARIANTS];

  let drift = 0;
  for (const variant of selected) {
    const rendered = renderVariant(variant);
    if (toStdout) {
      process.stdout.write(rendered);
      continue;
    }
    const target = renderedUrl(variant);
    if (check) {
      const current = readFileSync(target, 'utf8');
      if (current !== rendered) {
        drift += 1;
        process.stderr.write(
          `drift: docs/policy/rendered/${variant}.html is stale — run \`npm run policy:render\`\n`,
        );
      }
    } else {
      writeFileSync(target, rendered);
      process.stdout.write(`rendered docs/policy/rendered/${variant}.html\n`);
    }
  }
  if (check && drift === 0) process.stdout.write('policy pages are up to date\n');
  return drift > 0 ? 1 : 0;
}

if (isEntrypoint()) {
  process.exit(main(process.argv.slice(2)));
}
