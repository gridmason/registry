/**
 * Publish-upload request parsing (FR-1, SPEC §3, §8).
 *
 * An upload is a separable, analyzable artifact: a manifest + the frontend
 * remote (`entry` module + chunks) + schemas + docs, plus the signed source
 * archive (GW-D19 interim) and the publisher signature envelope. The `gridmason`
 * CLI sends it as a single JSON document whose file parts carry their **exact
 * bytes** base64-encoded — the bytes the registry content-addresses and the CDN
 * later serves verbatim. (A streaming multipart transport for very large bundles
 * is a later optimisation; the JSON+base64 contract keeps intake within the same
 * bounded-body, `inject()`-testable surface as the rest of the control-plane API,
 * and the configured body limit bounds it.)
 *
 * Parsing is pure and total: it never touches the store, the object store, or
 * the network, and it returns a typed error code rather than throwing, so the
 * route maps each failure to a stable `400` without a try/catch. Identity checks
 * that need state — the tag falling under the publisher's prefix, version
 * immutability — happen in the route, not here.
 */

/** The role a file plays in the artifact (SPEC §3 upload composition). */
export type ArtifactFileRole = 'manifest' | 'entry' | 'chunk' | 'schema' | 'doc';

const FILE_ROLES: readonly ArtifactFileRole[] = [
  'manifest',
  'entry',
  'chunk',
  'schema',
  'doc',
];

/** One decoded file part: its served path, role, and exact bytes. */
export interface ArtifactFile {
  readonly path: string;
  readonly role: ArtifactFileRole;
  readonly bytes: Uint8Array;
}

/** A fully parsed, structurally-valid upload ready for hashing + persistence. */
export interface ParsedUpload {
  readonly tag: string;
  readonly version: string;
  readonly files: readonly ArtifactFile[];
  /** Exact bytes of the signed source archive (GW-D19 interim review input). */
  readonly sourceArchive: Uint8Array;
  /** The publisher signature envelope, structurally validated, stored opaquely. */
  readonly envelope: unknown;
}

/** Why an upload body was refused. Each maps to a stable `400` error code. */
export type UploadParseErrorCode =
  | 'invalid_request'
  | 'invalid_artifact'
  | 'invalid_envelope';

export type ParseUploadResult =
  | { readonly ok: true; readonly upload: ParsedUpload }
  | { readonly ok: false; readonly code: UploadParseErrorCode; readonly message: string };

function fail(code: UploadParseErrorCode, message: string): ParseUploadResult {
  return { ok: false, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode strict base64 to bytes, or `null` if `value` is not well-formed base64.
 * `Buffer.from(_, 'base64')` is lenient (it silently drops invalid characters),
 * so the shape is validated first — an upload that does not round-trip is a
 * malformed artifact, not something to silently coerce and hash.
 */
function decodeBase64(value: string): Uint8Array | null {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function isFileRole(value: unknown): value is ArtifactFileRole {
  return typeof value === 'string' && (FILE_ROLES as readonly string[]).includes(value);
}

/**
 * Parse and structurally validate a publish-upload body. Requires a `tag` and
 * `version`, a `files[]` with exactly one `manifest` and exactly one `entry` and
 * unique non-empty paths, a `sourceArchive`, and a DSSE-shaped `envelope`.
 */
export function parseArtifactUpload(
  body: unknown,
  isValidEnvelope: (value: unknown) => boolean,
): ParseUploadResult {
  if (!isPlainObject(body)) {
    return fail('invalid_request', 'request body must be a JSON object');
  }

  if (typeof body.tag !== 'string' || body.tag === '') {
    return fail('invalid_request', 'tag is required and must be a non-empty string');
  }
  if (typeof body.version !== 'string' || body.version === '') {
    return fail('invalid_request', 'version is required and must be a non-empty string');
  }

  if (!Array.isArray(body.files) || body.files.length === 0) {
    return fail('invalid_request', 'files is required and must be a non-empty array');
  }

  const files: ArtifactFile[] = [];
  const seenPaths = new Set<string>();
  for (const raw of body.files) {
    if (!isPlainObject(raw)) {
      return fail('invalid_artifact', 'each file must be an object');
    }
    if (typeof raw.path !== 'string' || raw.path === '') {
      return fail('invalid_artifact', 'each file needs a non-empty path');
    }
    if (seenPaths.has(raw.path)) {
      return fail('invalid_artifact', `duplicate file path "${raw.path}"`);
    }
    if (!isFileRole(raw.role)) {
      return fail(
        'invalid_artifact',
        `file "${raw.path}" has an invalid role (expected one of ${FILE_ROLES.join(', ')})`,
      );
    }
    if (typeof raw.bytes !== 'string') {
      return fail('invalid_artifact', `file "${raw.path}" is missing base64 bytes`);
    }
    const bytes = decodeBase64(raw.bytes);
    if (bytes === null) {
      return fail('invalid_artifact', `file "${raw.path}" bytes are not valid base64`);
    }
    seenPaths.add(raw.path);
    files.push({ path: raw.path, role: raw.role, bytes });
  }

  const manifestCount = files.filter((f) => f.role === 'manifest').length;
  if (manifestCount !== 1) {
    return fail('invalid_artifact', 'an upload must carry exactly one manifest');
  }
  const entryCount = files.filter((f) => f.role === 'entry').length;
  if (entryCount !== 1) {
    return fail('invalid_artifact', 'an upload must carry exactly one entry module');
  }

  if (typeof body.sourceArchive !== 'string' || body.sourceArchive === '') {
    return fail(
      'invalid_request',
      'sourceArchive (the signed source archive) is required as base64 bytes',
    );
  }
  const sourceArchive = decodeBase64(body.sourceArchive);
  if (sourceArchive === null || sourceArchive.byteLength === 0) {
    return fail('invalid_artifact', 'sourceArchive is not valid, non-empty base64');
  }

  if (!isValidEnvelope(body.envelope)) {
    return fail(
      'invalid_envelope',
      'a structurally valid publisher signature envelope is required',
    );
  }

  return {
    ok: true,
    upload: { tag: body.tag, version: body.version, files, sourceArchive, envelope: body.envelope },
  };
}
