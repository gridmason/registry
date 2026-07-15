import { describe, expect, it } from 'vitest';

import { isStructurallyValidEnvelope } from '../../src/artifact/envelope.js';
import { parseArtifactUpload } from '../../src/artifact/upload.js';

const b64 = (s: string): string => Buffer.from(s).toString('base64');

const validEnvelope = {
  formatVersion: '1.0',
  subject: { artifact: 'acme-clock@1.2.0', releaseHash: `sha2-256:${'ab'.repeat(32)}` },
  publisherSig: {
    alg: 'ES256',
    cert: 'MIIBQ2R1bW15Y2VydA==',
    issuer: 'https://issuer.example',
    subjectClaims: { email: 'dev@acme.example' },
    sig: 'ZHVtbXktc2ln',
  },
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
  it('accepts a protocol SignatureEnvelope publisher half', () => {
    expect(isStructurallyValidEnvelope(validEnvelope)).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', [validEnvelope]],
    ['a string', 'envelope'],
    ['a bad formatVersion', { ...validEnvelope, formatVersion: 'x' }],
    ['a missing subject', { formatVersion: '1.0', publisherSig: validEnvelope.publisherSig }],
    ['a subject without releaseHash', { ...validEnvelope, subject: { artifact: 'acme-clock@1.2.0' } }],
    ['a missing publisherSig', { formatVersion: '1.0', subject: validEnvelope.subject }],
    ['a non-ES256 alg', { ...validEnvelope, publisherSig: { ...validEnvelope.publisherSig, alg: 'RS256' } }],
    ['an empty cert', { ...validEnvelope, publisherSig: { ...validEnvelope.publisherSig, cert: '' } }],
    ['non-string subjectClaims', { ...validEnvelope, publisherSig: { ...validEnvelope.publisherSig, subjectClaims: { n: 1 } } }],
    // The legacy DSSE shape @gridmason/cli ≤ 0.5.x uploaded is now rejected (registry#55).
    ['a legacy DSSE envelope', { payloadType: 't', payload: 'p', signatures: [{ sig: 's' }] }],
    // A publisher must not present the registry countersignature; the parser rejects it.
    ['an already-countersigned envelope', { ...validEnvelope, registrySig: { alg: 'ES256', cert: 'c', sig: 's' } }],
  ])('rejects %s', (_label, value) => {
    expect(isStructurallyValidEnvelope(value)).toBe(false);
  });
});
