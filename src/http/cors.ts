/**
 * Wildcard CORS for the anonymous public surfaces (issue #57).
 *
 * Browser-based hosts — the Gridmason Dashboard, any embedding app — are
 * cross-origin by definition (a dashboard on `localhost:5173` calling a registry
 * on `localhost:8080`), so the anonymous distribution surfaces they consume must
 * send CORS headers and answer preflight `OPTIONS`, or the browser blocks the
 * fetch. These surfaces are safe to open to **any** origin with a wildcard:
 *
 * - they take **no credentials** — no cookies, no `Authorization` — so `Access-
 *   Control-Allow-Origin: *` (without `Allow-Credentials`) exposes nothing an
 *   anonymous `curl` could not already read; and
 * - their content is **hash-addressed immutable bytes** or **registry-signed
 *   documents** a host verifies with `@gridmason/protocol` before trusting — the
 *   requesting origin is not a trust boundary here (SPEC §8, §10).
 *
 * The authenticated control plane (publisher registration, review lane, ops
 * revoke/kill, publisher-facing status/appeal) is deliberately **not** opened: a
 * cross-origin browser preflight for its `Authorization` header finds no matching
 * CORS response and is blocked, so the control plane stays non-browser-callable
 * cross-origin. Because anonymous and authenticated routes are interleaved within
 * the same route plugins (the feed shares a plugin with ops revoke/kill; the
 * anonymous publisher/prefix reads share one with authenticated registration),
 * CORS is applied here by an **explicit route allowlist** — the precise unit —
 * rather than by encapsulating a CORS plugin around a route plugin, which would
 * spill onto those authenticated siblings.
 */
import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';

import type { Logger } from '../logging/index.js';

/**
 * The concrete server instance type — a Fastify instance whose logger is the
 * app's pino {@link Logger} (see `server.ts`). Matching it here lets the wiring
 * pass its `app` directly (a bare `FastifyInstance` would clash on the logger
 * generic under `strictFunctionTypes`).
 */
type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger
>;

/** One anonymous public route that receives wildcard CORS. */
export interface PublicCorsRoute {
  readonly method: 'GET' | 'POST';
  /** The Fastify route URL template (e.g. `/v1/artifacts/:hash`). */
  readonly url: string;
}

/**
 * The anonymous public surfaces (every anonymous read/resolve a host consumes),
 * and **only** those — no authenticated publisher/ops route appears here. Adding a
 * new anonymous surface means adding it here; an authenticated one must never be.
 */
export const PUBLIC_CORS_ROUTES: readonly PublicCorsRoute[] = [
  { method: 'POST', url: '/v1/resolve' }, // resolution — gate snapshot → import-map fragment
  { method: 'GET', url: '/v1/widgets' }, // widget catalog — list/search published widgets
  { method: 'GET', url: '/v1/revocation/feed' }, // signed revocation & kill feed
  { method: 'GET', url: '/v1/artifacts/:hash' }, // hash-addressed serving origin
  { method: 'GET', url: '/v1/releases/:hash' }, // countersigned release documents
  { method: 'GET', url: '/v1/publishers/:id' }, // anonymous publisher record read
  { method: 'GET', url: '/v1/prefixes/:prefix' }, // anonymous prefix-ownership read
];

const ALLOW_ORIGIN = '*';
/** Preflight cache: how long a browser may reuse a preflight result (10 minutes). */
const MAX_AGE_SECONDS = '600';
/**
 * The only non-safelisted **request** header a host sends to these surfaces is
 * `content-type` (the JSON `POST /v1/resolve`). The public surfaces take no
 * `Authorization`, so it is intentionally absent — that is what keeps the
 * authenticated control plane non-browser-callable.
 */
const ALLOW_HEADERS = 'content-type';

/**
 * Non-safelisted **response** headers a host may read off these surfaces:
 * `etag` (the serving origin's content-hash validator) and the correlation-id
 * header. The CORS-safelisted response headers (`content-type`, `cache-control`,
 * `content-length`, …) are readable without being listed here.
 */
function exposeHeaders(requestIdHeader: string): string {
  return `etag, ${requestIdHeader}`;
}

function keyOf(method: string, url: string | undefined): string {
  return `${method} ${url ?? ''}`;
}

export interface PublicCorsOptions {
  /** The correlation-id response header to expose (`config.requestIdHeader`). */
  readonly requestIdHeader: string;
  /** Override the route allowlist (tests); defaults to {@link PUBLIC_CORS_ROUTES}. */
  readonly routes?: readonly PublicCorsRoute[];
}

/**
 * Wire wildcard CORS onto the anonymous public surfaces of `app`:
 *
 * 1. an `onRequest` hook stamps `Access-Control-Allow-Origin: *` and
 *    `Access-Control-Expose-Headers` on **every** response of an allowlisted route
 *    (including its `404`s and its preflight), and nothing on any other route; and
 * 2. an explicit `OPTIONS` handler per allowlisted route answers preflight with
 *    `204` + `Allow-Methods` / `Allow-Headers` / `Max-Age`. A preflight to a route
 *    not on the list matches no handler and `404`s — the browser then blocks the
 *    cross-origin call, which is the intended posture for the control plane.
 */
export function registerPublicCors(app: AppInstance, options: PublicCorsOptions): void {
  const routes = options.routes ?? PUBLIC_CORS_ROUTES;
  const expose = exposeHeaders(options.requestIdHeader);
  // The set of allowlisted routes, keyed by `METHOD url-template` so the actual
  // request and its preflight are matched exactly (never by path prefix).
  const allow = new Set(routes.map((r) => keyOf(r.method, r.url)));
  // The OPTIONS route url → the allowed real method, for the preflight response.
  const preflightMethods = new Map<string, string>();
  for (const r of routes) {
    const existing = preflightMethods.get(r.url);
    preflightMethods.set(r.url, existing ? `${existing}, ${r.method}` : r.method);
  }

  app.addHook('onRequest', async (request, reply) => {
    const url = request.routeOptions?.url;
    if (url === undefined) return;
    // An allowlisted real request, or the preflight registered against the same url.
    if (allow.has(keyOf(request.method, url)) || (request.method === 'OPTIONS' && preflightMethods.has(url))) {
      reply.header('access-control-allow-origin', ALLOW_ORIGIN);
      reply.header('access-control-expose-headers', expose);
    }
  });

  for (const [url, methods] of preflightMethods) {
    app.options(url, async (_request, reply) => {
      reply.header('access-control-allow-methods', `${methods}, OPTIONS`);
      reply.header('access-control-allow-headers', ALLOW_HEADERS);
      reply.header('access-control-max-age', MAX_AGE_SECONDS);
      // `Allow-Origin` + `Expose-Headers` are set by the onRequest hook above.
      return reply.code(204).send();
    });
  }
}
