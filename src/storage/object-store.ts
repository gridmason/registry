/**
 * Object-store abstraction.
 *
 * Bundles, release documents, and feeds are hash-addressed blobs served from an
 * S3-compatible store (SPEC §9). The service depends on the {@link ObjectStore}
 * interface, not on the AWS SDK directly: the S3 implementation backs production
 * and the dev-compose MinIO, while {@link InMemoryObjectStore} backs tests and
 * lets the service run storage-complete without a live store.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { ObjectStoreConfig } from '../config/index.js';

export interface PutOptions {
  readonly contentType?: string;
}

export interface ObjectHead {
  readonly size: number;
}

export interface ObjectStore {
  /** Store `body` under `key`, overwriting any existing object. */
  putObject(key: string, body: Uint8Array | string, options?: PutOptions): Promise<void>;
  /** Fetch an object's bytes, or `null` if the key does not exist. */
  getObject(key: string): Promise<Uint8Array | null>;
  /** Return an object's metadata, or `null` if the key does not exist. */
  headObject(key: string): Promise<ObjectHead | null>;
  /** Remove an object; a no-op if the key does not exist. */
  deleteObject(key: string): Promise<void>;
  /** Verify the store and configured bucket are reachable; throws otherwise. */
  ping(): Promise<void>;
  /** Release any held resources. */
  close(): Promise<void>;
}

/** True when an S3 SDK error signals a missing key/bucket rather than a fault. */
function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: string }).name;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

/**
 * S3-compatible {@link ObjectStore}. Works against real AWS S3 and self-hosted
 * stores (MinIO) via endpoint + path-style overrides. Credentials fall back to
 * the SDK's default provider chain when not configured explicitly.
 */
export function createS3ObjectStore(
  config: ObjectStoreConfig,
  deps: { client?: S3Client } = {},
): ObjectStore {
  const client =
    deps.client ??
    new S3Client({
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    });
  const bucket = config.bucket;

  return {
    async putObject(key, body, options) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ...(options?.contentType ? { ContentType: options.contentType } : {}),
        }),
      );
    },

    async getObject(key) {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (!response.Body) return null;
        return await response.Body.transformToByteArray();
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async headObject(key) {
      try {
        const response = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return { size: response.ContentLength ?? 0 };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async ping() {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    },

    async close() {
      client.destroy();
    },
  };
}

/**
 * In-memory {@link ObjectStore}. Backs tests and lets the service satisfy its
 * storage contract without a live store; never for production (nothing is
 * durable and nothing is shared across processes).
 */
export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, { body: Uint8Array; contentType?: string }>();

  putObject(key: string, body: Uint8Array | string, options?: PutOptions): Promise<void> {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    this.objects.set(key, {
      body: bytes,
      ...(options?.contentType ? { contentType: options.contentType } : {}),
    });
    return Promise.resolve();
  }

  getObject(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.objects.get(key)?.body ?? null);
  }

  headObject(key: string): Promise<ObjectHead | null> {
    const object = this.objects.get(key);
    return Promise.resolve(object ? { size: object.body.byteLength } : null);
  }

  deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
