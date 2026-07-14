import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config/index.js';

describe('loadConfig', () => {
  it('applies documented defaults for an empty environment', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'info',
      serviceName: 'gridmason-registry',
      requestIdHeader: 'x-request-id',
      shutdownTimeoutMs: 10_000,
    });
  });

  it('reads and coerces provided values', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'debug',
      SERVICE_NAME: 'registry-test',
      REQUEST_ID_HEADER: 'X-Correlation-Id',
      SHUTDOWN_TIMEOUT_MS: '5000',
    });
    expect(config.nodeEnv).toBe('production');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('debug');
    expect(config.serviceName).toBe('registry-test');
    expect(config.requestIdHeader).toBe('x-correlation-id');
    expect(config.shutdownTimeoutMs).toBe(5000);
  });

  it('rejects a non-integer port', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/between 1 and 65535/);
  });

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(ConfigError);
  });
});
