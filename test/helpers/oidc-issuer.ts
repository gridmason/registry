/**
 * A fake OIDC issuer for tests: a real local HTTP server that serves an OIDC
 * discovery document and a JWKS, plus helpers to mint tokens. Exercising the
 * verifier against a live endpoint (rather than a stubbed fetch) covers the
 * discovery → jwks_uri → key-fetch path the way production runs it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

const ALG = 'RS256';
const KID = 'test-key-1';

/** The private-key type `generateKeyPair` yields, inferred to avoid a key-type import. */
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

type ClaimSet = Record<string, unknown>;

export interface FakeIssuer {
  /** The issuer URL (also the discovery base and the token `iss`). */
  readonly issuer: string;
  /** The `kid` of the published signing key. */
  readonly kid: string;
  /** Sign a token with the issuer's *published* key (the valid path). */
  sign(claims: ClaimSet): Promise<string>;
  /**
   * Sign with a private key whose public half is NOT in the JWKS, but stamp the
   * published `kid` — models a forged token: the verifier selects the real key
   * and the signature fails to verify.
   */
  signWithWrongKey(claims: ClaimSet): Promise<string>;
  /** Sign with HS256 (a symmetric alg the verifier must refuse: alg-confusion). */
  signHs256(claims: ClaimSet, secret: string): Promise<string>;
  /** Build an unsecured `alg: none` token (no signature) the verifier must refuse. */
  unsecured(claims: ClaimSet): string;
  /** Force the discovery endpoint to fail with this status (null = serve normally). */
  failDiscovery(status: number | null): void;
  /** Force the JWKS endpoint to fail with this status (null = serve normally). */
  failJwks(status: number | null): void;
  close(): Promise<void>;
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  const signing = await generateKeyPair(ALG, { extractable: true });
  const wrong = await generateKeyPair(ALG, { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(signing.publicKey)), kid: KID, alg: ALG, use: 'sig' };

  let discoveryStatus: number | null = null;
  let jwksStatus: number | null = null;
  let issuer = '';

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (url === '/.well-known/openid-configuration') {
      if (discoveryStatus !== null) {
        res.writeHead(discoveryStatus).end('discovery unavailable');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      return;
    }
    if (url === '/jwks') {
      if (jwksStatus !== null) {
        res.writeHead(jwksStatus).end('jwks unavailable');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${port}`;

  const signWith = (key: SigningKey, claims: ClaimSet): Promise<string> =>
    new SignJWT(claims).setProtectedHeader({ alg: ALG, kid: KID }).sign(key);

  return {
    issuer,
    kid: KID,
    sign: (claims) => signWith(signing.privateKey, claims),
    signWithWrongKey: (claims) => signWith(wrong.privateKey, claims),
    signHs256: (claims, secret) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256', kid: KID })
        .sign(new TextEncoder().encode(secret)),
    unsecured: (claims) =>
      `${encodeSegment({ alg: 'none', typ: 'JWT' })}.${encodeSegment(claims)}.`,
    failDiscovery: (status) => {
      discoveryStatus = status;
    },
    failJwks: (status) => {
      jwksStatus = status;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
