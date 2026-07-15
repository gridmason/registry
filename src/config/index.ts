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

/**
 * Registry countersignature key custody (SPEC §2, §4a — the countersign key is
 * held separately from review staff).
 *
 * The key is sourced from a **custody-controlled secret**, never derived from or
 * shared with any review-lane identity ({@link ReviewConfig.reviewerIdentities}):
 * these two fields come from their own environment variables so the separation is
 * visible in the wiring. Both empty means the instance has no countersign key
 * configured and the countersign stage does not mount — an instance that only
 * runs intake/review (e.g. the Phase-A author-loop demo) needs neither.
 *
 * Custody guidance and the openssl provisioning recipe live in
 * `docs/countersign.md`; the secret is mounted into the process (env or a
 * secret-manager projection), it is never written from the application UI.
 */
export interface CountersignConfig {
  /**
   * PEM-encoded PKCS#8 private key (ECDSA P-256) the registry signs the
   * countersignature with. Empty when no countersign key is configured.
   */
  readonly privateKeyPem: string;
  /**
   * PEM-encoded X.509 certificate (ECDSA P-256 leaf) carried in the
   * countersignature envelope; hosts pin its issuing root as a countersign root.
   * Empty when no countersign key is configured.
   */
  readonly certificatePem: string;
}

/**
 * Signed revocation & kill feed settings (SPEC §6, FR-8). The registry owns
 * distribution state and publishes it as a signed feed; these tune how it is
 * served. The feed is signed with the countersign key ({@link CountersignConfig})
 * so hosts verify it against the same trust root — no separate feed key.
 */
export interface RevocationConfig {
  /**
   * Freshness window (seconds) stamped on each served feed: how long a host may
   * cache before it MUST re-check (fail-closed, scoped to this registry). Bounded
   * at 24 h (SPEC §6 max TTL); the default is 1 h so a kill propagates within the
   * §6 online bound (≤ 1 h) — a shorter TTL forces hosts to re-check sooner.
   */
  readonly feedTtlSeconds: number;
}

/**
 * Registry operator settings (SPEC §6, §8 Ops API). The SCOPE-minimal cut ships
 * no operator console; the operators permitted to issue a revoke/kill are a
 * config-listed identity set (the same pattern as the reviewer roster,
 * {@link ReviewConfig.reviewerIdentities}).
 */
export interface OpsConfig {
  /**
   * The OIDC identities permitted to issue a revoke/kill, in the canonical
   * `composeOidcIdentity` composite form. Empty means no identity can operate the
   * kill switch (fail closed) — an instance must configure at least one operator
   * before the ops surface will act.
   */
  readonly operatorIdentities: readonly string[];
}

/** Which transparency log the countersign stage anchors releases in. */
export type TransparencyLogDriver = 'memory' | 'rekor';

/**
 * Transparency-log settings (SPEC §2 §4.3, GW-D17). The flagship anchors to the
 * public Sigstore infrastructure (Rekor) rather than operating its own log; the
 * self-hosted Rekor fallback is Phase C and is not built here.
 */
export interface TransparencyLogConfig {
  /**
   * `rekor` for the real Sigstore/Rekor HTTP client (production, GW-D17);
   * `memory` for the in-process append-only log (dev + tests). Defaults to
   * `memory` so a fresh instance boots without a network dependency.
   */
  readonly driver: TransparencyLogDriver;
  /** Base URL of the Rekor instance when `driver === 'rekor'` (e.g. the public `https://rekor.sigstore.dev`). */
  readonly rekorUrl: string;
  /**
   * A **stable** signing key for the in-process `memory` log, as base64 of a
   * PKCS#8 DER Ed25519 private key (`TRANSPARENCY_LOG_MEMORY_KEY`; generate with
   * `npm run log-key:gen`). Empty means a fresh key is generated each boot — the
   * ephemeral default, whose checkpoints no host can pin across restarts. Set it
   * so `trust-root:init` can publish the log key and a host can verify releases
   * after a restart. Dev/e2e only; a production instance anchors to `rekor`.
   */
  readonly memoryKeyDerBase64: string;
  /**
   * The log's checkpoint `origin` line (its identity in signed tree heads).
   * Defaults to this registry's id so a self-hosted `memory` log names itself.
   */
  readonly origin: string;
  /**
   * Escape hatch for running the in-process `memory` log in production
   * (`NODE_ENV=production`). The `memory` log is not durable and anchors to
   * nothing public, so a production instance that forgets to set `rekor` would
   * silently skip public anchoring — boot **refuses** that combination unless this
   * is explicitly set (`TRANSPARENCY_LOG_ALLOW_MEMORY_IN_PRODUCTION=true`). Kept
   * as a deliberate override for a self-host operator running a production-mode
   * process without external Rekor (they accept the no-public-log tradeoff); off
   * by default so the safe path is the default.
   */
  readonly allowMemoryInProduction: boolean;
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
  /** Registry countersignature key custody (held separately from review staff). */
  readonly countersign: CountersignConfig;
  /** Signed revocation & kill feed settings. */
  readonly revocation: RevocationConfig;
  /** Registry operator settings (the identities permitted to revoke/kill). */
  readonly ops: OpsConfig;
  /** Transparency-log settings the countersign stage anchors releases in. */
  readonly transparencyLog: TransparencyLogConfig;
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

/**
 * Read a PEM secret from the environment, tolerating a single-line value whose
 * newlines were `\n`-escaped (the common shape when a PEM is projected into an
 * env var). Empty/absent yields `''` — the caller treats that as "not configured".
 */
function readPem(env: Env, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw === '') return '';
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
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
 * Refuse to boot a production instance on the non-durable in-process
 * transparency log unless explicitly overridden (#38, security follow-up). The
 * `memory` driver anchors to nothing public, so a production instance that
 * forgot to set `rekor` would silently skip the public anchoring FR-5 promises —
 * a fail-fast at boot is far better than discovering it after the fact. Non-prod
 * keeps `memory` as the zero-config default (a boot warning is surfaced
 * separately via {@link collectBootWarnings}); the override lets a self-hoster who
 * accepts the tradeoff run a production-mode process without external Rekor.
 */
function validateTransparencyLog(nodeEnv: NodeEnv, log: TransparencyLogConfig): void {
  if (nodeEnv === 'production' && log.driver === 'memory' && !log.allowMemoryInProduction) {
    throw new ConfigError(
      'TRANSPARENCY_LOG_DRIVER=memory is refused in production (NODE_ENV=production): ' +
        'the in-process log is not durable and anchors to nothing public, so releases ' +
        'would skip public transparency anchoring. Set TRANSPARENCY_LOG_DRIVER=rekor, or ' +
        'set TRANSPARENCY_LOG_ALLOW_MEMORY_IN_PRODUCTION=true to override (self-host only, ' +
        'accepting no public log).',
    );
  }
}

/**
 * Non-fatal boot warnings for a loaded {@link Config}. Logged once at startup so a
 * risky-but-permitted configuration is visible without failing the boot. Today the
 * only warning is a non-production instance running the non-durable `memory`
 * transparency log — the safe default for dev, but worth a line in the log.
 */
export function collectBootWarnings(config: Config): string[] {
  const warnings: string[] = [];
  if (config.nodeEnv !== 'production' && config.transparencyLog.driver === 'memory') {
    const stable = config.transparencyLog.memoryKeyDerBase64 !== '';
    warnings.push(
      'TRANSPARENCY_LOG_DRIVER=memory: using the in-process transparency log — ' +
        'not durable and not publicly anchored. Fine for dev/test; set ' +
        'TRANSPARENCY_LOG_DRIVER=rekor for any instance that ships real releases.' +
        (stable
          ? ' Signing key is STABLE (TRANSPARENCY_LOG_MEMORY_KEY) — pinnable and ' +
            'stable across restarts (publish it via trust-root:init).'
          : ' Signing key is EPHEMERAL (regenerated each boot) — previously logged ' +
            'releases cannot be verified after a restart, and no host can pin it. ' +
            'Set TRANSPARENCY_LOG_MEMORY_KEY (npm run log-key:gen) for a stable key.'),
    );
  }
  if (config.nodeEnv === 'production' && config.transparencyLog.driver === 'memory') {
    // Reached only via the explicit override (boot would have refused otherwise).
    warnings.push(
      'TRANSPARENCY_LOG_DRIVER=memory in production via ' +
        'TRANSPARENCY_LOG_ALLOW_MEMORY_IN_PRODUCTION: releases are NOT publicly anchored.',
    );
  }
  return warnings;
}

/**
 * Build the immutable {@link Config} from an environment map (defaults to
 * `process.env`). Throws {@link ConfigError} on the first invalid value.
 */
export function loadConfig(env: Env = process.env): Config {
  const issuerAllowlist = readStringList(env, 'OIDC_ISSUER_ALLOWLIST', []);
  validateIssuerAllowlist(issuerAllowlist);
  const nodeEnv = readEnum(env, 'NODE_ENV', 'development', NODE_ENVS);
  const transparencyLog: TransparencyLogConfig = {
    driver: readEnum(env, 'TRANSPARENCY_LOG_DRIVER', 'memory', ['memory', 'rekor'] as const),
    rekorUrl: readString(env, 'TRANSPARENCY_LOG_REKOR_URL', 'https://rekor.sigstore.dev'),
    // Defaults to the registry id so a self-hosted memory log names itself.
    origin: readString(
      env,
      'TRANSPARENCY_LOG_ORIGIN',
      readString(env, 'REGISTRY_ID', 'registry.local'),
    ),
    memoryKeyDerBase64: readString(env, 'TRANSPARENCY_LOG_MEMORY_KEY', ''),
    allowMemoryInProduction: readBool(env, 'TRANSPARENCY_LOG_ALLOW_MEMORY_IN_PRODUCTION', false),
  };
  validateTransparencyLog(nodeEnv, transparencyLog);
  return {
    nodeEnv,
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
    countersign: {
      // Custody-controlled secrets, sourced from their own env vars — never from a
      // reviewer identity (SPEC §2). A single-line env value may `\n`-escape the
      // PEM newlines; normalize them back so a projected secret works either way.
      privateKeyPem: readPem(env, 'COUNTERSIGN_PRIVATE_KEY'),
      certificatePem: readPem(env, 'COUNTERSIGN_CERTIFICATE'),
    },
    revocation: {
      // Bounded at the SPEC §6 max TTL (24 h); defaults to 1 h so a kill lands
      // within the online propagation bound.
      feedTtlSeconds: readInt(env, 'REVOCATION_FEED_TTL_SECONDS', 3_600, {
        min: 1,
        max: 86_400,
      }),
    },
    ops: {
      operatorIdentities: readStringList(env, 'OPS_OPERATOR_IDENTITIES', []),
    },
    transparencyLog,
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
