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
      registryId: 'registry.local',
      oidc: {
        issuerAllowlist: [],
        audience: '',
      },
      review: {
        reviewerIdentities: [],
        selfReviewWaiver: false,
      },
      http: {
        bodyLimitBytes: 65_536,
        maxHeaderSizeBytes: 16_384,
      },
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

  it('reads the registry id and parses the OIDC issuer allowlist', () => {
    const config = loadConfig({
      REGISTRY_ID: 'registry.example.com',
      OIDC_ISSUER_ALLOWLIST: 'https://a.example , https://b.example',
    });
    expect(config.registryId).toBe('registry.example.com');
    expect(config.oidc.issuerAllowlist).toEqual(['https://a.example', 'https://b.example']);
  });

  it('defaults the OIDC issuer allowlist to empty (fail closed)', () => {
    expect(loadConfig({}).oidc.issuerAllowlist).toEqual([]);
  });

  it('reads the OIDC audience and defaults it to empty (unchecked)', () => {
    expect(loadConfig({}).oidc.audience).toBe('');
    expect(loadConfig({ OIDC_AUDIENCE: 'registry.example.com' }).oidc.audience).toBe(
      'registry.example.com',
    );
  });

  it('defaults the review lane to an empty reviewer set and the waiver off', () => {
    expect(loadConfig({}).review).toEqual({
      reviewerIdentities: [],
      selfReviewWaiver: false,
    });
  });

  it('parses the reviewer set and the self-review waiver flag', () => {
    const config = loadConfig({
      REVIEW_REVIEWER_IDENTITIES: 'https%3A%2F%2Fissuer.example reviewer-1 , https%3A%2F%2Fissuer.example reviewer-2',
      REVIEW_SELF_REVIEW_WAIVER: 'true',
    });
    expect(config.review.reviewerIdentities).toEqual([
      'https%3A%2F%2Fissuer.example reviewer-1',
      'https%3A%2F%2Fissuer.example reviewer-2',
    ]);
    expect(config.review.selfReviewWaiver).toBe(true);
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

  it('applies default HTTP transport caps and reads overrides', () => {
    expect(loadConfig({}).http).toEqual({
      bodyLimitBytes: 65_536,
      maxHeaderSizeBytes: 16_384,
    });
    const config = loadConfig({
      HTTP_BODY_LIMIT_BYTES: '131072',
      HTTP_MAX_HEADER_SIZE_BYTES: '32768',
    });
    expect(config.http).toEqual({
      bodyLimitBytes: 131_072,
      maxHeaderSizeBytes: 32_768,
    });
  });

  it('rejects an out-of-range HTTP header size cap', () => {
    // Below the 8 KiB floor (must stay above an 8 KiB bearer token).
    expect(() => loadConfig({ HTTP_MAX_HEADER_SIZE_BYTES: '4096' })).toThrow(ConfigError);
  });

  it('accepts a well-formed https issuer allowlist', () => {
    expect(
      loadConfig({ OIDC_ISSUER_ALLOWLIST: 'https://a.example, https://b.example/oidc' })
        .oidc.issuerAllowlist,
    ).toEqual(['https://a.example', 'https://b.example/oidc']);
  });

  it('allows http only for a loopback issuer (dev)', () => {
    expect(
      loadConfig({ OIDC_ISSUER_ALLOWLIST: 'http://localhost:8080, http://127.0.0.1:9000' })
        .oidc.issuerAllowlist,
    ).toEqual(['http://localhost:8080', 'http://127.0.0.1:9000']);
  });

  it('rejects a plain-http non-loopback issuer at boot (item 5)', () => {
    expect(() => loadConfig({ OIDC_ISSUER_ALLOWLIST: 'http://issuer.example' })).toThrow(
      /must be an https/,
    );
  });

  it('rejects a malformed issuer URL at boot (item 5)', () => {
    expect(() => loadConfig({ OIDC_ISSUER_ALLOWLIST: 'not-a-url' })).toThrow(
      /not a valid URL/,
    );
  });
});
