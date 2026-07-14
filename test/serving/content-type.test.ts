/**
 * Content-type inference (#12): a served path's extension picks a sensible MIME
 * type, ES-module remotes serve as `text/javascript` (native ESM loading refuses
 * anything else), and an unknown/extensionless path falls back to the
 * non-executable `application/octet-stream` default.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONTENT_TYPE, contentTypeForPath } from '../../src/serving/content-type.js';

describe('contentTypeForPath', () => {
  it('serves ES-module remotes as a JavaScript MIME type', () => {
    expect(contentTypeForPath('entry.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeForPath('chunks/widget.mjs')).toBe('text/javascript; charset=utf-8');
  });

  it('maps the manifest, schemas, and source maps to JSON', () => {
    expect(contentTypeForPath('manifest.json')).toBe('application/json; charset=utf-8');
    expect(contentTypeForPath('schema/props.json')).toBe('application/json; charset=utf-8');
    expect(contentTypeForPath('entry.js.map')).toBe('application/json; charset=utf-8');
  });

  it('maps common bundle assets', () => {
    expect(contentTypeForPath('styles.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeForPath('mod.wasm')).toBe('application/wasm');
    expect(contentTypeForPath('icon.svg')).toBe('image/svg+xml');
    expect(contentTypeForPath('README.md')).toBe('text/markdown; charset=utf-8');
  });

  it('is case-insensitive on the extension', () => {
    expect(contentTypeForPath('ENTRY.JS')).toBe('text/javascript; charset=utf-8');
  });

  it('falls back to octet-stream for unknown or extensionless paths', () => {
    expect(contentTypeForPath('data.bin')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForPath('LICENSE')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForPath('.gitignore')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForPath('weird.dir.name/file')).toBe(DEFAULT_CONTENT_TYPE);
  });
});
