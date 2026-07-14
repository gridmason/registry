import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import type { ObjectStoreConfig } from '../src/config/index.js';
import {
  createS3ObjectStore,
  InMemoryObjectStore,
} from '../src/storage/object-store.js';

const config: ObjectStoreConfig = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'test-bucket',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  forcePathStyle: true,
};

/** Minimal fake standing in for the S3 client's `send`. */
interface SentCommand {
  name: string;
  input: Record<string, unknown>;
}

function fakeClient(
  handler: (command: SentCommand) => unknown,
): { client: S3Client; sent: SentCommand[] } {
  const sent: SentCommand[] = [];
  const client = {
    send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const record = { name: command.constructor.name, input: command.input };
      sent.push(record);
      return Promise.resolve(handler(record));
    },
    destroy() {},
  } as unknown as S3Client;
  return { client, sent };
}

describe('InMemoryObjectStore', () => {
  it('round-trips bytes and string bodies', async () => {
    const store = new InMemoryObjectStore();
    await store.putObject('a', new Uint8Array([1, 2, 3]));
    await store.putObject('b', 'hello');

    expect(await store.getObject('a')).toEqual(new Uint8Array([1, 2, 3]));
    expect(new TextDecoder().decode((await store.getObject('b'))!)).toBe('hello');
  });

  it('reports null for a missing key and a size for an existing one', async () => {
    const store = new InMemoryObjectStore();
    expect(await store.getObject('missing')).toBeNull();
    expect(await store.headObject('missing')).toBeNull();

    await store.putObject('x', 'abcd');
    expect(await store.headObject('x')).toEqual({ size: 4 });
  });

  it('deletes objects', async () => {
    const store = new InMemoryObjectStore();
    await store.putObject('x', 'y');
    await store.deleteObject('x');
    expect(await store.getObject('x')).toBeNull();
  });

  it('always pings ready', async () => {
    await expect(new InMemoryObjectStore().ping()).resolves.toBeUndefined();
  });
});

describe('createS3ObjectStore', () => {
  it('puts with bucket, key, body, and content type', async () => {
    const { client, sent } = fakeClient(() => ({}));
    const store = createS3ObjectStore(config, { client });
    await store.putObject('bundles/abc', 'data', { contentType: 'application/json' });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe('PutObjectCommand');
    expect(sent[0]!.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'bundles/abc',
      Body: 'data',
      ContentType: 'application/json',
    });
  });

  it('returns object bytes on get', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const { client } = fakeClient((command) =>
      command.name === 'GetObjectCommand'
        ? { Body: { transformToByteArray: () => Promise.resolve(bytes) } }
        : {},
    );
    const store = createS3ObjectStore(config, { client });
    expect(await store.getObject('k')).toEqual(bytes);
  });

  it('maps a NoSuchKey error to null on get', async () => {
    const { client } = fakeClient(() => {
      throw Object.assign(new Error('missing'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
    });
    const store = createS3ObjectStore(config, { client });
    expect(await store.getObject('k')).toBeNull();
  });

  it('maps a 404 head to null and returns size otherwise', async () => {
    const notFound = fakeClient(() => {
      throw Object.assign(new Error('nope'), { $metadata: { httpStatusCode: 404 } });
    });
    const missing = createS3ObjectStore(config, { client: notFound.client });
    expect(await missing.headObject('k')).toBeNull();

    const present = fakeClient(() => ({ ContentLength: 42 }));
    const store = createS3ObjectStore(config, { client: present.client });
    expect(await store.headObject('k')).toEqual({ size: 42 });
  });

  it('pings via HeadBucket against the configured bucket', async () => {
    const { client, sent } = fakeClient(() => ({}));
    const store = createS3ObjectStore(config, { client });
    await store.ping();
    expect(sent[0]!.name).toBe('HeadBucketCommand');
    expect(sent[0]!.input).toEqual({ Bucket: 'test-bucket' });
  });

  it('propagates non-not-found errors on get', async () => {
    const { client } = fakeClient(() => {
      throw Object.assign(new Error('access denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });
    });
    const store = createS3ObjectStore(config, { client });
    await expect(store.getObject('k')).rejects.toThrow('access denied');
  });
});
