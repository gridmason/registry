/**
 * Rekor client response mapping (#10): the production log client maps a Rekor
 * `POST /api/v1/log/entries` response onto our `TransparencyLogEntry` and fails
 * loudly on a rejected submission. Exercised with a stubbed transport — no network.
 */
import { describe, expect, it } from 'vitest';

import { RekorTransparencyLog, type FetchLike } from '../../src/sigstore/rekor.js';

const input = {
  body: new TextEncoder().encode('leaf'),
  releaseHash: `sha2-256:${'ab'.repeat(32)}`,
  signatureB64: 'c2ln',
  certificateB64: 'Y2VydA==',
};

const rekorResponse = {
  'uuid-123': {
    logID: 'ff'.repeat(32),
    logIndex: 42,
    integratedTime: 1_700_000_000,
    body: 'ZW50cnk=',
    verification: {
      inclusionProof: {
        logIndex: 7,
        rootHash: 'cd'.repeat(32),
        treeSize: 8,
        hashes: ['ab'.repeat(32), 'cd'.repeat(32)],
        checkpoint: 'rekor.sigstore.dev\n8\ncm9vdA==\n\n— rekor AAAA\n',
      },
    },
  },
};

function stubFetch(status: number, payload: unknown): FetchLike {
  return () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    });
}

describe('RekorTransparencyLog', () => {
  it('maps a Rekor entry onto the protocol entry shape', async () => {
    const log = new RekorTransparencyLog({ baseUrl: 'https://rekor.sigstore.dev/', fetch: stubFetch(201, rekorResponse) });
    const { entry, logRef } = await log.append(input);

    expect(entry.logId).toBe('ff'.repeat(32));
    // The inclusion proof's own logIndex is the leaf index within its tree.
    expect(entry.index).toBe(7);
    expect(entry.canonicalBody).toBe('ZW50cnk=');
    expect(entry.inclusionProof.treeSize).toBe(8);
    expect(entry.inclusionProof.hashes).toHaveLength(2);
    expect(entry.checkpoint).toContain('rekor.sigstore.dev');
    expect(logRef).toBe(`${'ff'.repeat(32)}:7`);
  });

  it('throws on a rejected submission', async () => {
    const log = new RekorTransparencyLog({ baseUrl: 'https://rekor.sigstore.dev', fetch: stubFetch(429, 'rate limited') });
    await expect(log.append(input)).rejects.toThrow(/Rekor submission failed \(429\)/);
  });

  it('throws when the response carries no inclusion proof', async () => {
    const noProof = { 'uuid-x': { logID: 'a', logIndex: 1, integratedTime: 1, body: 'e30=' } };
    const log = new RekorTransparencyLog({ baseUrl: 'https://rekor.sigstore.dev', fetch: stubFetch(201, noProof) });
    await expect(log.append(input)).rejects.toThrow(/no inclusion proof/);
  });
});
