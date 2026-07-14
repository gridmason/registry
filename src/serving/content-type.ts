/**
 * Content-type inference for the hash-addressed serving surface (#12, SPEC §10).
 *
 * A served object is addressed by content hash, but a runtime still needs a
 * sensible `Content-Type` — native ESM loading (GW-D22) refuses a module whose
 * response is not a JavaScript MIME type, so `entry`/`chunk` remotes must serve
 * as `text/javascript`. The type is a presentation hint over immutable bytes, so
 * it is inferred from the served path recorded in the signed release document,
 * never sniffed from the bytes. An unknown extension falls back to
 * `application/octet-stream` — the safe default a browser will not execute.
 */

/** The default for any path whose extension we do not map. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * Served-path extension → MIME type. Covers what a widget/plugin remote ships
 * (SPEC §3: manifest + `entry` + chunks + schemas + docs) plus the common static
 * assets a bundle may include. `charset=utf-8` is set on text formats so a host
 * decodes them without guessing.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  // A source map is JSON; hosts fetch it out-of-band, never execute it.
  map: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8',
  wasm: 'application/wasm',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/**
 * The `Content-Type` for a served path, by its lowercase extension. Falls back to
 * {@link DEFAULT_CONTENT_TYPE} for an unknown or extensionless path.
 */
export function contentTypeForPath(path: string): string {
  // Take the final path segment so a directory named `foo.js/bar` does not fool
  // the extension split, then the substring after its last dot.
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return DEFAULT_CONTENT_TYPE;
  const ext = base.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? DEFAULT_CONTENT_TYPE;
}
