/**
 * Uniform error body for the JSON API. Every non-2xx response carries
 * `{ error: { code, message } }` — a stable machine `code` the CLI switches on
 * plus a human `message` — so callers never have to parse prose or depend on the
 * HTTP status alone.
 */
import type { FastifyReply } from 'fastify';

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/** Set the status and send the uniform error body in one call. */
export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): ErrorBody {
  reply.code(status);
  return errorBody(code, message);
}
