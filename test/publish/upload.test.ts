import { describe, expect, it } from 'vitest';

import { isStructurallyValidEnvelope } from '../../src/artifact/envelope.js';
import { parseArtifactUpload } from '../../src/artifact/upload.js';

const b64 = (s: string): string => Buffer.from(s).toString('base64');

const validEnvelope = {
  payloadType: 'application/vnd.gridmason.artifact+json',
  payload: b64('{"tag":"acme-clock"}'),
  signatures: [{ sig: 'MEUCIQ', keyid: 'oidc' }],
};

function validBody(): Record<string, unknown> {
  return {
    tag: 'acme-clock',
    version: '1.2.0',
    files: [
      { path: 'manifest.json', role: 'manifest', bytes: b64('{"tag":"acme-clock"}') },
      { path: 'entry.js', role: 'entry', bytes: b64('export default 1') },
      { path: 'chunks/a.js', role: 'chunk', bytes: b64('a') },
      { path: 'schemas/config.json', role: 'schema', bytes: b64('{}') },
      { path: 'README.md', role: 'doc', bytes: b64('# hi') },
    ],
    sourceArchive: b64('tarball-bytes'),
    envelope: validEnvelope,
  };
}

const parse = (body: unknown) => parseArtifactUpload(body, isStructurallyValidEnvelope);

describe('parseArtifactUpload', () => {
  it('parses a well-formed upload, decoding every file to bytes', () => {
    const result = parse(validBody());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.upload.tag).toBe('acme-clock');
    expect(result.upload.version).toBe('1.2.0');
    expect(result.upload.files).toHaveLength(5);
    expect(new TextDecoder().decode(result.upload.files[0]!.bytes)).toBe('{"tag":"acme-clock"}');
    expect(new TextDecoder().decode(result.upload.sourceArchive)).toBe('tarball-bytes');
    expect(result.upload.envelope).toEqual(validEnvelope);
  });

  it.each([
    ['a non-object body', 'not-an-object', 'invalid_request'],
    ['a missing tag', { ...validBody(), tag: undefined }, 'invalid_request'],
    ['a missing version', { ...validBody(), version: 123 }, 'invalid_request'],
    ['no files', { ...validBody(), files: [] }, 'invalid_request'],
    ['a missing source archive', { ...validBody(), sourceArchive: undefined }, 'invalid_request'],
  ])('rejects %s with %s', (_label, body, code) => {
    const result = parse(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(code);
  });

  it('rejects a file with an unknown role', () => {
    const body = validBody();
    (body.files as Array<Record<string, unknown>>)[0]!.role = 'binary';
    const result = parse(body);
    expect(result).toMatchObject({ ok: false, code: 'invalid_artifact' });
  });

  it('rejects a file whose bytes are not valid base64', () => {
    const body = validBody();
    (body.files as Array<Record<string, unknown>>)[1]!.bytes = 'not base64!!';
    const result = parse(body);
    expect(result).toMatchObject({ ok: false, code: 'invalid_artifact' });
  });

  it('rejects duplicate file paths', () => {
    const body = validBody();
    (body.files as Array<Record<string, unknown>>)[1]!.path = 'manifest.json';
    const result = parse(body);
    expect(result).toMatchObject({ ok: false, code: 'invalid_artifact' });
  });

  it('requires exactly one manifest', () => {
    const body = validBody();
    (body.files as Array<Record<string, unknown>>)[1]!.role = 'manifest';
    const result = parse(body);
    expect(result).toMatchObject({ ok: false, code: 'invalid_artifact' });
  });

  it('requires exactly one entry module', () => {
    const body = validBody();
    body.files = (body.files as Array<Record<string, unknown>>).filter((f) => f.role !== 'entry');
    const result = parse(body);
    expect(result).toMatchObject({ ok: false, code: 'invalid_artifact' });
  });

  it('rejects an empty source archive', () => {
    const result = parse({ ...validBody(), sourceArchive: b64('') });
    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('rejects a missing or malformed envelope with invalid_envelope', () => {
    expect(parse({ ...validBody(), envelope: undefined })).toMatchObject({
      ok: false,
      code: 'invalid_envelope',
    });
    expect(parse({ ...validBody(), envelope: { payloadType: 'x' } })).toMatchObject({
      ok: false,
      code: 'invalid_envelope',
    });
  });
});

describe('isStructurallyValidEnvelope', () => {
  it('accepts a DSSE-shaped envelope', () => {
    expect(isStructurallyValidEnvelope(validEnvelope)).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', [validEnvelope]],
    ['a string', 'envelope'],
    ['a missing payloadType', { payload: 'p', signatures: [{ sig: 's' }] }],
    ['a missing payload', { payloadType: 't', signatures: [{ sig: 's' }] }],
    ['empty signatures', { payloadType: 't', payload: 'p', signatures: [] }],
    ['a signature without sig', { payloadType: 't', payload: 'p', signatures: [{ keyid: 'k' }] }],
    ['a non-array signatures', { payloadType: 't', payload: 'p', signatures: 's' }],
  ])('rejects %s', (_label, value) => {
    expect(isStructurallyValidEnvelope(value)).toBe(false);
  });
});
