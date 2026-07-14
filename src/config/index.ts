/**
 * Typed, env-driven configuration for the registry service.
 *
 * Every field is sourced from an environment variable with a documented default
 * (see `docs/config.md`). Parsing is strict: an out-of-range or malformed value
 * fails fast at boot with a descriptive error rather than surfacing later as a
 * confusing runtime failure.
 */

export type NodeEnv = 'development' | 'production' | 'test';

export type LogLevel =
  | 'fatal'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug'
  | 'trace'
  | 'silent';

const LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

const NODE_ENVS: readonly NodeEnv[] = ['development', 'production', 'test'];

/** Postgres connection settings (records, review queue, audit log). */
export interface PostgresConfig {
  /** libpq-style connection URL. */
  readonly url: string;
  /** Maximum number of pooled connections. */
  readonly poolMax: number;
  /** Milliseconds to wait for a connection from the pool before failing. */
  readonly connectionTimeoutMs: number;
}

/** OIDC identity settings (SPEC §2 — the issuer is the trust anchor). */
export interface OidcConfig {
  /**
   * Allowlist of trusted OIDC issuer URLs. A publisher registration's bearer
   * token is accepted only when its `iss` claim is one of these; a token from
   * any other issuer is refused. Empty means no issuer is trusted, so no
   * publisher can register (fail closed) — an instance must configure at least
   * one issuer before it accepts registrations.
   */
  readonly issuerAllowlist: readonly string[];
  /**
   * Required token audience (`aud`). When set, a registration token is accepted
   * only if its `aud` claim includes this value; when empty the audience is not
   * checked. Set it to this registry's canonical id so a token minted for a
   * different relying party cannot be replayed here.
   */
  readonly audience: string;
}

/** Human review lane settings (SPEC §4, §4a — the one review lane this cut ships). */
export interface ReviewConfig {
  /**
   * The v0 reviewer set: the OIDC identities permitted to submit a verdict, in
   * the canonical `composeOidcIdentity` composite form (`<url-encoded-issuer>
   * <url-encoded-subject>`) — the same string the audit log and publisher records
   * key on. There is no reviewer console this phase (SCOPE cut), so the reviewer
   * roster is config, not data. Empty means no identity can review (fail closed).
   */
  readonly reviewerIdentities: readonly string[];
  /**
   * The disclosed flagship self-review waiver (SPEC §4a). When `true`, an operator
   * who authored an artifact may also review it (separation of duties waived while
   * the flagship is single-rostered); the waiver use is recorded on the review
   * case and audited so the release can be flagged. **Off by default and never
   * enabled on a self-host instance** — every self-hoster keeps reviewer≠author.
   */
  readonly selfReviewWaiver: boolean;
}

/** HTTP transport caps applied at the Fastify/Node server boundary. */
export interface HttpConfig {
  /**
   * Maximum accepted request body size in bytes. The control-plane API only
   * takes small JSON bodies, so this is set well below Fastify's 1 MiB default
   * to bound memory an unauthenticated caller can force us to buffer.
   */
  readonly bodyLimitBytes: number;
  /**
   * Maximum total size (bytes) of the request header block, passed to the
   * underlying Node HTTP server. Comfortably above an 8 KiB bearer token plus
   * ordinary headers, but bounded so oversized header floods are rejected early.
   */
  readonly maxHeaderSizeBytes: number;
}

/** S3-compatible object-store settings (artifacts, release docs, feeds). */
export interface ObjectStoreConfig {
  /**
   * Service endpoint, e.g. `http://localhost:9000` for MinIO. Empty means the
   * AWS SDK resolves the endpoint from the region (real S3).
   */
  readonly endpoint: string;
  /** Region sent with every request (S3-compatible stores still require one). */
  readonly region: string;
  /** Bucket that holds all registry objects. */
  readonly bucket: string;
  /** Access key id; empty falls back to the SDK's default credential chain. */
  readonly accessKeyId: string;
  /** Secret access key; empty falls back to the SDK's default credential chain. */
  readonly secretAccessKey: string;
  /**
   * Path-style addressing (`endpoint/bucket/key`). Required for MinIO and most
   * self-hosted S3 stores; real AWS S3 uses virtual-host style (`false`).
   */
  readonly forcePathStyle: boolean;
}

export interface Config {
  /** Deployment mode; influences defaults and (later) error verbosity. */
  readonly nodeEnv: NodeEnv;
  /** Interface the HTTP server binds to. */
  readonly host: string;
  /** TCP port the HTTP server listens on. */
  readonly port: number;
  /** Minimum level emitted by the structured logger. */
  readonly logLevel: LogLevel;
  /** Logical service name attached to every log line. */
  readonly serviceName: string;
  /**
   * Inbound header carrying a caller-supplied correlation id. When present its
   * value is adopted as the request id; otherwise one is generated per request.
   */
  readonly requestIdHeader: string;
  /** Grace period for in-flight requests to drain on shutdown before force-exit. */
  readonly shutdownTimeoutMs: number;
  /**
   * This instance's source-qualified registry id (SPEC §9). Every output that
   * carries publisher identity is qualified with it so hosts resolve by
   * `(registry, publisher, tag)`; prefixes are unique only within this id.
   */
  readonly registryId: string;
  /** OIDC identity settings. */
  readonly oidc: OidcConfig;
  /** Human review lane settings. */
  readonly review: ReviewConfig;
  /** HTTP transport caps. */
  readonly http: HttpConfig;
  /** Postgres connection settings. */
  readonly postgres: PostgresConfig;
  /** S3-compatible object-store settings. */
  readonly objectStore: ObjectStoreConfig;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function readString(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw;
}

function readInt(
  env: Env,
  key: string,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`${key} must be an integer, got "${raw}"`);
  }
  if (parsed < min || parsed > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

function readStringList(env: Env, key: string, fallback: readonly string[]): string[] {
  const raw = env[key];
  if (raw === undefined || raw === '') return [...fallback];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function readBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new ConfigError(`${key} must be a boolean (true/false), got "${raw}"`);
}

function readEnum<T extends string>(
  env: Env,
  key: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return raw as T;
}

function isLoopbackHost(hostname: string): boolean {
  // URL strips the brackets from an IPv6 literal, so `[::1]` arrives as `::1`.
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * Validate the OIDC issuer allowlist at boot (fail fast — item 5). Each entry
 * must be a well-formed absolute `https://` URL; plain `http://` is permitted
 * only for loopback hosts so a local dev issuer still works. A malformed or
 * insecure entry throws {@link ConfigError} rather than surfacing later as a
 * confusing discovery failure at first registration.
 */
function validateIssuerAllowlist(issuers: readonly string[]): void {
  for (const issuer of issuers) {
    let url: URL;
    try {
      url = new URL(issuer);
    } catch {
      throw new ConfigError(
        `OIDC_ISSUER_ALLOWLIST entry "${issuer}" is not a valid URL`,
      );
    }
    if (url.protocol === 'https:') continue;
    if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) continue;
    throw new ConfigError(
      `OIDC_ISSUER_ALLOWLIST entry "${issuer}" must be an https:// URL ` +
        '(http:// is allowed only for a loopback host)',
    );
  }
}

/**
 * Build the immutable {@link Config} from an environment map (defaults to
 * `process.env`). Throws {@link ConfigError} on the first invalid value.
 */
export function loadConfig(env: Env = process.env): Config {
  const issuerAllowlist = readStringList(env, 'OIDC_ISSUER_ALLOWLIST', []);
  validateIssuerAllowlist(issuerAllowlist);
  return {
    nodeEnv: readEnum(env, 'NODE_ENV', 'development', NODE_ENVS),
    host: readString(env, 'HOST', '0.0.0.0'),
    port: readInt(env, 'PORT', 8080, { min: 1, max: 65535 }),
    logLevel: readEnum(env, 'LOG_LEVEL', 'info', LOG_LEVELS),
    serviceName: readString(env, 'SERVICE_NAME', 'gridmason-registry'),
    requestIdHeader: readString(env, 'REQUEST_ID_HEADER', 'x-request-id').toLowerCase(),
    shutdownTimeoutMs: readInt(env, 'SHUTDOWN_TIMEOUT_MS', 10_000, {
      min: 0,
      max: 300_000,
    }),
    // Neutral local default; production sets this to the instance's canonical id
    // (e.g. registry.gridmason.dev), which becomes the widget `source` string.
    registryId: readString(env, 'REGISTRY_ID', 'registry.local'),
    oidc: {
      issuerAllowlist,
      audience: readString(env, 'OIDC_AUDIENCE', ''),
    },
    review: {
      reviewerIdentities: readStringList(env, 'REVIEW_REVIEWER_IDENTITIES', []),
      // Off by default; a self-host instance must never turn it on (SPEC §4a).
      selfReviewWaiver: readBool(env, 'REVIEW_SELF_REVIEW_WAIVER', false),
    },
    http: {
      bodyLimitBytes: readInt(env, 'HTTP_BODY_LIMIT_BYTES', 65_536, {
        min: 1_024,
        max: 10_485_760,
      }),
      maxHeaderSizeBytes: readInt(env, 'HTTP_MAX_HEADER_SIZE_BYTES', 16_384, {
        min: 8_192,
        max: 1_048_576,
      }),
    },
    postgres: {
      // Default targets the local dev compose (see compose.yaml). Production
      // deployments always set DATABASE_URL explicitly.
      url: readString(
        env,
        'DATABASE_URL',
        'postgres://gridmason:gridmason@localhost:5432/gridmason',
      ),
      poolMax: readInt(env, 'DATABASE_POOL_MAX', 10, { min: 1, max: 1000 }),
      connectionTimeoutMs: readInt(env, 'DATABASE_CONNECTION_TIMEOUT_MS', 5_000, {
        min: 0,
        max: 120_000,
      }),
    },
    objectStore: {
      // Defaults target the local dev compose MinIO instance.
      endpoint: readString(env, 'OBJECT_STORE_ENDPOINT', 'http://localhost:9000'),
      region: readString(env, 'OBJECT_STORE_REGION', 'us-east-1'),
      bucket: readString(env, 'OBJECT_STORE_BUCKET', 'gridmason-registry'),
      accessKeyId: readString(env, 'OBJECT_STORE_ACCESS_KEY_ID', 'gridmason'),
      secretAccessKey: readString(
        env,
        'OBJECT_STORE_SECRET_ACCESS_KEY',
        'gridmason-dev-secret',
      ),
      forcePathStyle: readBool(env, 'OBJECT_STORE_FORCE_PATH_STYLE', true),
    },
  };
}

export { ConfigError };
