import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createHttpRateLimiter,
  type HttpRateLimiter,
  type HttpRateLimitOptions,
  type HttpRateLimitOutcome,
  nodeHeaderReader,
  PROBLEM_CONTENT_TYPE,
  pathOf,
  problemBody,
} from '../http.js';

/** Structural Express request (works with Express 4 and 5). */
export interface ExpressRateLimitRequest extends IncomingMessage {
  originalUrl?: string;
  user?: unknown;
  /** Set by the middleware for downstream handlers. */
  rateLimit?: HttpRateLimitOutcome;
}

export type ExpressRateLimitMiddleware = (
  req: ExpressRateLimitRequest,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

function isHttpRateLimiter(value: unknown): value is HttpRateLimiter {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HttpRateLimiter).evaluate === 'function'
  );
}

/**
 * Express middleware. Adds rate limit headers, rejects limited requests with
 * `application/problem+json`, and exposes the outcome as `req.rateLimit`.
 * The client IP is resolved from the socket and `trustProxy`; Express `trust proxy` is not used.
 */
export function rateLimit(
  options: HttpRateLimitOptions | HttpRateLimiter,
): ExpressRateLimitMiddleware {
  const http = isHttpRateLimiter(options) ? options : createHttpRateLimiter(options);
  return (req, res, next) => {
    http
      .evaluate({
        method: req.method ?? 'GET',
        path: pathOf(req.originalUrl ?? req.url),
        remoteAddress: req.socket?.remoteAddress,
        header: nodeHeaderReader(req.headers),
        user: req.user,
        raw: req,
      })
      .then((outcome) => {
        req.rateLimit = outcome;
        if (!res.headersSent) {
          for (const [name, value] of Object.entries(outcome.headers)) res.setHeader(name, value);
        }
        if (outcome.action === 'allow') {
          next();
          return;
        }
        res.statusCode = outcome.status;
        res.setHeader('Content-Type', PROBLEM_CONTENT_TYPE);
        res.setHeader('Cache-Control', 'no-store');
        res.end(problemBody(outcome));
      })
      .catch(next);
  };
}
