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

/**
 * Build the immutable {@link Config} from an environment map (defaults to
 * `process.env`). Throws {@link ConfigError} on the first invalid value.
 */
export function loadConfig(env: Env = process.env): Config {
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
  };
}

export { ConfigError };
