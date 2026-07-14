/**
 * HTTP server assembly.
 *
 * Builds the Fastify instance from an already-loaded {@link Config} and
 * {@link Logger}, wires correlation-id handling, and mounts the routes that
 * exist at the skeleton stage (health only). No publish/review/serving/
 * resolution surface is registered here — those arrive in R-E1/R-E2.
 */
import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';

import {
  createPostgresArtifactStore,
  type ArtifactStore,
} from './artifact/store.js';
import { createOidcVerifier, type OidcVerifier } from './auth/oidc.js';
import type { Config } from './config/index.js';
import { healthRoutes } from './http/health.js';
import { publishRoutes } from './http/publish.js';
import { publisherRoutes } from './http/publisher.js';
import {
  createDefaultReadinessRegistry,
  type ReadinessRegistry,
} from './http/readiness.js';
import type { Logger } from './logging/index.js';
import { createPostgresPublisherStore, type PublisherStore } from './publisher/store.js';
import type { ObjectStore } from './storage/object-store.js';
import { registerStorageProbes, type Storage } from './storage/index.js';

export interface BuildServerOptions {
  config: Config;
  logger: Logger;
  /** Override the readiness registry (tests inject their own). */
  readiness?: ReadinessRegistry;
  /**
   * Storage bundle. When provided, its Postgres and object-store liveness
   * replace the skeleton's placeholder `storage` readiness probe.
   */
  storage?: Storage;
  /**
   * Publisher store backing the publisher/prefix API. Defaults to a
   * Postgres-backed store over `storage.postgres` when `storage` is given; tests
   * inject an in-memory store. Absent both, the publisher routes are not mounted.
   */
  publisherStore?: PublisherStore;
  /**
   * Artifact store backing the publish API. Defaults to a Postgres-backed store
   * over `storage.postgres` when `storage` is given; tests inject an in-memory
   * store. The publish routes mount only when this and an object store are wired.
   */
  artifactStore?: ArtifactStore;
  /**
   * Object store the publish API content-addresses uploaded blobs into. Defaults
   * to `storage.objectStore` when `storage` is given; tests inject an in-memory
   * store.
   */
  objectStore?: ObjectStore;
  /**
   * OIDC verifier backing publisher registration and publish intake. Defaults to
   * one built from `config.oidc` (real discovery + JWKS). Tests inject a verifier
   * wired to a local fake issuer so no network is touched.
   */
  oidcVerifier?: OidcVerifier;
}

export async function buildServer(options: BuildServerOptions) {
  const { config, logger } = options;
  const readiness = options.readiness ?? createDefaultReadinessRegistry();

  if (options.storage) {
    registerStorageProbes(readiness, options.storage);
  }

  const app = Fastify({
    loggerInstance: logger,
    // Adopt a caller-supplied correlation id from the configured header; fall
    // back to a fresh UUID. Fastify binds this id to the per-request child
    // logger under `reqId`.
    requestIdHeader: config.requestIdHeader,
    genReqId: () => randomUUID(),
    // Explicit transport caps rather than Node/Fastify defaults: bound the body
    // an unauthenticated caller can make us buffer, and the total header block
    // size at the underlying HTTP server (bearer tokens ride in a header).
    bodyLimit: config.http.bodyLimitBytes,
    http: { maxHeaderSize: config.http.maxHeaderSizeBytes },
  });

  // Echo the correlation id back so callers can stitch client and server logs.
  app.addHook('onSend', async (request, reply) => {
    reply.header(config.requestIdHeader, request.id);
  });

  await app.register(healthRoutes, {
    readiness,
    serviceName: config.serviceName,
  });

  const publisherStore =
    options.publisherStore ??
    (options.storage
      ? createPostgresPublisherStore(options.storage.postgres, logger)
      : undefined);
  if (publisherStore) {
    const verifier =
      options.oidcVerifier ??
      createOidcVerifier({
        issuerAllowlist: config.oidc.issuerAllowlist,
        audience: config.oidc.audience === '' ? undefined : config.oidc.audience,
      });
    await app.register(publisherRoutes, {
      store: publisherStore,
      registryId: config.registryId,
      verifier,
    });

    // The publish API keys against publisher records for identity + prefix, so it
    // mounts only alongside the publisher routes and only when its own stores are
    // wired. It shares the one verifier so both surfaces enforce the same policy.
    const artifactStore =
      options.artifactStore ??
      (options.storage
        ? createPostgresArtifactStore(options.storage.postgres, logger)
        : undefined);
    const objectStore = options.objectStore ?? options.storage?.objectStore;
    if (artifactStore && objectStore) {
      await app.register(publishRoutes, {
        publisherStore,
        artifactStore,
        objectStore,
        registryId: config.registryId,
        verifier,
      });
    }
  }

  return app;
}
