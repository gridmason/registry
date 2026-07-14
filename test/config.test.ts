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
      postgres: {
        url: 'postgres://gridmason:gridmason@localhost:5432/gridmason',
        poolMax: 10,
        connectionTimeoutMs: 5_000,
      },
      objectStore: {
        endpoint: 'http://localhost:9000',
        region: 'us-east-1',
        bucket: 'gridmason-registry',
        accessKeyId: 'gridmason',
        secretAccessKey: 'gridmason-dev-secret',
        forcePathStyle: true,
      },
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

  it('reads storage settings from the environment', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://u:p@db:5432/reg',
      DATABASE_POOL_MAX: '25',
      DATABASE_CONNECTION_TIMEOUT_MS: '2000',
      OBJECT_STORE_ENDPOINT: 'https://s3.example.com',
      OBJECT_STORE_REGION: 'eu-west-1',
      OBJECT_STORE_BUCKET: 'prod-bucket',
      OBJECT_STORE_ACCESS_KEY_ID: 'AKIA',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'secret',
      OBJECT_STORE_FORCE_PATH_STYLE: 'false',
    });
    expect(config.postgres).toEqual({
      url: 'postgres://u:p@db:5432/reg',
      poolMax: 25,
      connectionTimeoutMs: 2_000,
    });
    expect(config.objectStore).toEqual({
      endpoint: 'https://s3.example.com',
      region: 'eu-west-1',
      bucket: 'prod-bucket',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      forcePathStyle: false,
    });
  });

  it('accepts 1/0 as booleans and rejects other strings', () => {
    expect(loadConfig({ OBJECT_STORE_FORCE_PATH_STYLE: '1' }).objectStore.forcePathStyle).toBe(
      true,
    );
    expect(loadConfig({ OBJECT_STORE_FORCE_PATH_STYLE: '0' }).objectStore.forcePathStyle).toBe(
      false,
    );
    expect(() => loadConfig({ OBJECT_STORE_FORCE_PATH_STYLE: 'yes' })).toThrow(ConfigError);
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
