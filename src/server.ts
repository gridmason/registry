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
import {
  createPostgresAuditQueryStore,
  type AuditQueryStore,
} from './audit/query.js';
import { createOidcVerifier, type OidcVerifier } from './auth/oidc.js';
import type { Config } from './config/index.js';
import {
  createCountersignStage,
  loadCountersignIdentity,
  type CountersignIdentity,
  type CountersignStage,
} from './countersign/index.js';
import { createReleaseRedriveService } from './countersign/redrive.js';
import { createPostgresReleaseDocStore, type ReleaseDocStore } from './release/store.js';
import {
  createPostgresFeedEntryStore,
  createRevocationService,
  type FeedEntryStore,
} from './revocation/index.js';
import { createTransparencyLog, type TransparencyLog } from './sigstore/index.js';
import { healthRoutes } from './http/health.js';
import { publishRoutes } from './http/publish.js';
import { resolutionRoutes } from './http/resolution.js';
import type { RevocationCheck } from './resolution/index.js';
import { servingRoutes } from './http/serving.js';
import { publisherRoutes } from './http/publisher.js';
import { reviewRoutes } from './http/review.js';
import { revocationRoutes } from './http/revocation.js';
import { auditRoutes } from './http/audit.js';
import { releaseOpsRoutes } from './http/release-ops.js';
import {
  createDefaultReadinessRegistry,
  type ReadinessRegistry,
} from './http/readiness.js';
import type { Logger } from './logging/index.js';
import { createPostgresPublisherStore, type PublisherStore } from './publisher/store.js';
import { createAutomatedReviewStage } from './review/automated.js';
import { createHumanReviewLane } from './review/human/lane.js';
import { createPostgresReviewCaseStore, type ReviewCaseStore } from './review/store.js';
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
   * Review-case store backing the automated-review stage (#8). Defaults to a
   * Postgres-backed store over `storage.postgres` when `storage` is given, so the
   * real service always reviews on publish; tests inject an in-memory store (or
   * omit it to exercise intake without review).
   */
  reviewCaseStore?: ReviewCaseStore;
  /**
   * Release-document store backing the countersign stage (#10). Defaults to a
   * Postgres-backed store over `storage.postgres`; tests inject an in-memory store.
   */
  releaseDocStore?: ReleaseDocStore;
  /**
   * Transparency log the countersign stage anchors releases in. Defaults to the
   * one named by `config.transparencyLog` (Rekor in production, an in-process log
   * in dev); tests inject the in-process log to read back its checkpoint key.
   */
  transparencyLog?: TransparencyLog;
  /**
   * Feed-entry store backing the revocation & kill feed (#14). Defaults to a
   * Postgres-backed store over `storage.postgres`; tests inject an in-memory store.
   */
  feedEntryStore?: FeedEntryStore;
  /**
   * Registry countersign identity (the separately-held key, SPEC §2). Defaults to
   * one loaded from `config.countersign`; when neither this nor config provides a
   * key, the countersign stage does not mount and approvals do not publish a release.
   */
  countersignIdentity?: CountersignIdentity;
  /**
   * OIDC verifier backing publisher registration and publish intake. Defaults to
   * one built from `config.oidc` (real discovery + JWKS). Tests inject a verifier
   * wired to a local fake issuer so no network is touched.
   */
  oidcVerifier?: OidcVerifier;
  /**
   * Audit-log read store backing the operator audit-query endpoint (#15). Defaults
   * to a Postgres-backed store over `storage.postgres`; tests inject an in-memory
   * store (typically the same object installed as the audit sink, so events emitted
   * by driven transitions are read back through the endpoint).
   */
  auditQueryStore?: AuditQueryStore;
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

  // Serving surface (#12): the anonymous, read-only, hash-addressed read origin
  // (blobs + countersigned release docs). It sits off the control-plane path
  // (SPEC §10), so it mounts on its own — independent of the publish/review
  // surface below — whenever an object store and a release-doc store are wired.
  const servingObjectStore = options.objectStore ?? options.storage?.objectStore;
  const servingReleaseDocStore =
    options.releaseDocStore ??
    (options.storage
      ? createPostgresReleaseDocStore(options.storage.postgres)
      : undefined);
  if (servingObjectStore && servingReleaseDocStore) {
    await app.register(servingRoutes, {
      objectStore: servingObjectStore,
      releaseDocStore: servingReleaseDocStore,
    });
  }

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
    // The review-case store backs both the automated stage (#8) and the human
    // lane (#9); the real service always has one (Postgres, backed by storage).
    const reviewCaseStore =
      options.reviewCaseStore ??
      (options.storage
        ? createPostgresReviewCaseStore(options.storage.postgres)
        : undefined);

    // The registry countersign identity (the separately-held key, SPEC §2) is
    // shared by two consumers: the approval-time countersign stage below and the
    // revocation-feed signer — both must verify against the same trust root
    // (SPEC §6), so they load the one key.
    const countersignIdentity =
      options.countersignIdentity ?? loadCountersignIdentity(config.countersign);

    if (artifactStore && objectStore) {
      // The automated-review stage mounts alongside publish whenever a review-case
      // store is available (always in the real service, where storage backs it),
      // so every accepted upload is reviewed before the response (FR-3).
      const reviewStage = reviewCaseStore
        ? createAutomatedReviewStage({ artifactStore, reviewCaseStore })
        : undefined;
      await app.register(publishRoutes, {
        publisherStore,
        artifactStore,
        objectStore,
        registryId: config.registryId,
        verifier,
        reviewStage,
      });
    }

    // The revocation & kill feed store (#14) is the registry's distribution-state
    // authority (SPEC §6). It is built here — ahead of both the resolution surface
    // and the feed's own ops routes below — so the resolution surface can cross-check
    // it. One instance is shared by both consumers.
    const feedEntryStore =
      options.feedEntryStore ??
      (options.storage ? createPostgresFeedEntryStore(options.storage.postgres) : undefined);

    // Resolution excludes a module on `state ∧ feed` (SPEC §6): the approved-only
    // state gate AND a cross-check of the signed revocation/kill feed. The feed check
    // is the seam #13 defined ({@link RevocationCheck}); wire it from the feed store
    // so a release revoked/killed out-of-band is excluded even before its state write
    // is observed. Absent a feed store, resolution falls back to the state gate alone.
    const revocationCheck: RevocationCheck | undefined = feedEntryStore
      ? { isRevoked: ({ artifactId }) => feedEntryStore.isBlocked(artifactId) }
      : undefined;

    // Resolution API (#13, FR-7/FR-10): the anonymous gate-snapshot → import-map
    // fragment surface. It maps enabled (publisher, tag, version) remotes to
    // hash-pinned serving URLs + signature bundles, so it needs the publisher,
    // artifact, release-doc, and object stores together. Like serving it sits off
    // the control plane and mounts once all four are wired; it reuses the serving
    // block's release-doc store so both read the same published releases.
    if (artifactStore && objectStore && servingReleaseDocStore) {
      await app.register(resolutionRoutes, {
        publisherStore,
        artifactStore,
        releaseDocStore: servingReleaseDocStore,
        objectStore,
        registryId: config.registryId,
        revocationCheck,
      });
    }

    // The human review lane (#9) acts on the `reviewing` artifacts the automated
    // stage produced: it needs the artifact + review-case stores (for the queue
    // and verdict) and the publisher store (to resolve authorship for
    // reviewer≠author). It shares the one verifier; the reviewer set + waiver are
    // config. No object store is required — verdicts move state, not bytes.
    if (artifactStore && reviewCaseStore) {
      // The countersign + transparency-logging stage (#10) runs on approval. It
      // mounts only when a separately-held countersign key is configured and a
      // release-doc store is available; otherwise an approval simply records the
      // verdict without publishing a release (the Phase-A author-loop demo shape).
      // It reuses the single `servingReleaseDocStore` built for the serving surface
      // so the whole server has one release-doc store — the same rows countersign
      // writes are what serving and resolution read (one source of truth).
      let onApprove: Parameters<typeof createHumanReviewLane>[0]['onApprove'];
      let countersignStage: CountersignStage | undefined;
      if (countersignIdentity && servingReleaseDocStore) {
        const transparencyLog =
          options.transparencyLog ?? createTransparencyLog(config.transparencyLog);
        countersignStage = createCountersignStage({
          identity: countersignIdentity,
          transparencyLog,
          releaseDocStore: servingReleaseDocStore,
          logger,
        });
        const stage = countersignStage;
        // The stage records its own faults; the hook resolves void so a publish
        // failure never unwinds the already-committed approval.
        onApprove = async (outcome) => {
          await stage.run({ artifact: outcome.artifact, waiverUsed: outcome.waiverUsed });
        };
      }

      const lane = createHumanReviewLane({
        artifactStore,
        reviewCaseStore,
        publisherStore,
        selfReviewWaiver: config.review.selfReviewWaiver,
        onApprove,
      });
      await app.register(reviewRoutes, {
        lane,
        verifier,
        reviewerIdentities: config.review.reviewerIdentities,
        registryId: config.registryId,
      });

      // The release re-drive ops endpoint (#38) completes an artifact left
      // approved-but-unpublished by a transparency-log outage. It reuses the same
      // countersign stage as the approval hook, so it only mounts when that stage
      // is wired (countersign key + release-doc store) — the same instances that
      // publish releases at all.
      if (countersignStage && servingReleaseDocStore) {
        const redriveService = createReleaseRedriveService({
          artifactStore,
          releaseDocStore: servingReleaseDocStore,
          reviewCaseStore,
          stage: countersignStage,
        });
        await app.register(releaseOpsRoutes, {
          service: redriveService,
          verifier,
          operatorIdentities: config.ops.operatorIdentities,
        });
      }
    }

    // The revocation & kill feed (#14) is the registry's distribution-state
    // authority (SPEC §6). It mounts when the countersign key is configured — the
    // feed is signed with it so hosts verify against the same trust root — and the
    // feed-entry store (built above, shared with the resolution cross-check) is
    // available. The public feed is anonymous; the revoke/kill ops endpoints are
    // gated on the config-listed operator set.
    if (artifactStore && feedEntryStore && countersignIdentity) {
      const service = createRevocationService({ artifactStore, feedEntryStore });
      await app.register(revocationRoutes, {
        service,
        feedEntryStore,
        countersignIdentity,
        verifier,
        operatorIdentities: config.ops.operatorIdentities,
        registryId: config.registryId,
        feedTtlSeconds: config.revocation.feedTtlSeconds,
      });
    }

    // The audit-query endpoint (#15, FR-12) reads back the trail every transition
    // writes. It is an operator surface (same operator set as revocation ops) but
    // needs no countersign key or feed store — only the verifier and an audit read
    // store — so it mounts on its own whenever a query store is available (always,
    // over storage; injected in tests).
    const auditQueryStore =
      options.auditQueryStore ??
      (options.storage ? createPostgresAuditQueryStore(options.storage.postgres) : undefined);
    if (auditQueryStore) {
      await app.register(auditRoutes, {
        store: auditQueryStore,
        verifier,
        operatorIdentities: config.ops.operatorIdentities,
      });
    }
  }

  return app;
}
