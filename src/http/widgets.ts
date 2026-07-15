/**
 * Widget catalog API (#63) — `GET /v1/widgets`, the anonymous list/search surface
 * hosts use to show users what a registry offers. It lists only **distributable**
 * widgets (the same predicate resolution gates on) grouped by `(publisher, tag)`,
 * newest version first, keyset-paginated. Anonymous and wildcard-CORS'd like the
 * other public reads (#57); the assembly lives in `../widgets/service`.
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import { decodeCursor, type WidgetCatalogService } from '../widgets/service.js';
import { sendError } from './errors.js';

/** Default page size, and the cap the route clamps `limit` to. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface WidgetRoutesOptions extends FastifyPluginOptions {
  service: WidgetCatalogService;
}

interface WidgetQuery {
  query?: string;
  publisher?: string;
  limit?: string;
  cursor?: string;
}

export async function widgetRoutes(app: FastifyInstance, options: WidgetRoutesOptions): Promise<void> {
  const { service } = options;

  app.get<{ Querystring: WidgetQuery }>('/v1/widgets', async (request, reply) => {
    const { query, publisher, limit: limitRaw, cursor } = request.query;

    let limit = DEFAULT_LIMIT;
    if (limitRaw !== undefined && limitRaw !== '') {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return sendError(reply, 400, 'invalid_request', `limit must be an integer between 1 and ${MAX_LIMIT}`);
      }
      limit = parsed;
    }

    // Validate the cursor up front so a mangled one is a clean 400, not silently
    // ignored (which would restart pagination and could loop a client).
    if (cursor !== undefined && cursor !== '' && decodeCursor(cursor) === null) {
      return sendError(reply, 400, 'invalid_cursor', 'cursor is not a valid pagination cursor');
    }

    const result = await service.listWidgets({
      limit,
      // Empty query/publisher strings are "no filter", not "match empty".
      ...(query !== undefined && query !== '' ? { query } : {}),
      ...(publisher !== undefined && publisher !== '' ? { publisher } : {}),
      ...(cursor !== undefined && cursor !== '' ? { cursor } : {}),
    });
    return reply.send(result);
  });
}
