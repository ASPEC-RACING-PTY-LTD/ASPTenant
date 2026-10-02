import {
  createHttpRateLimiter,
  type HttpRateLimiter,
  type HttpRateLimitOptions,
  type HttpRateLimitOutcome,
  PROBLEM_CONTENT_TYPE,
  problemBody,
} from '../http.js';

export interface FetchRateLimitOptions extends HttpRateLimitOptions {
  /**
   * Returns the directly connected peer address. The Fetch API does not expose it, so pass it
   * from your runtime. Without it (and without trusted proxy headers) every client shares the
   * "ip:unknown" bucket.
   */
  getRemoteAddress?: (request: Request) => string | undefined;
  /** Returns the authenticated user for `keys.user()`. */
  getUser?: (request: Request) => unknown;
}

export interface FetchRateLimiter {
  /** Evaluates the rules for a request. */
  check(request: Request): Promise<HttpRateLimitOutcome>;
  /** Builds the problem+json response for a rejected outcome. */
  rejection(outcome: HttpRateLimitOutcome): Response;
  /** Returns a copy of `response` with the outcome headers added. */
  applyHeaders(response: Response, outcome: HttpRateLimitOutcome): Response;
}

export function createFetchRateLimiter(options: FetchRateLimitOptions): FetchRateLimiter {
  const { getRemoteAddress, getUser, ...rest } = options;
  const http: HttpRateLimiter = createHttpRateLimiter(rest);
  return {
    check(request) {
      const url = new URL(request.url);
      return http.evaluate({
        method: request.method,
        path: url.pathname,
        remoteAddress: getRemoteAddress?.(request),
        header: (name) => request.headers.get(name) ?? undefined,
        user: getUser?.(request),
        raw: request,
      });
    },
    rejection(outcome) {
      return new Response(problemBody(outcome), {
        status: outcome.status,
        headers: {
          ...outcome.headers,
          'Content-Type': PROBLEM_CONTENT_TYPE,
          'Cache-Control': 'no-store',
        },
      });
    },
    applyHeaders(response, outcome) {
      const entries = Object.entries(outcome.headers);
      if (entries.length === 0) return response;
      const copy = new Response(response.body, response);
      for (const [name, value] of entries) copy.headers.set(name, value);
      return copy;
    },
  };
}

/** Wraps a Fetch handler `(request) => Response` with rate limiting. */
export function withRateLimit<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Response | Promise<Response>,
  options: FetchRateLimitOptions,
): (request: Request, ...args: Args) => Promise<Response> {
  const limiter = createFetchRateLimiter(options);
  return async (request, ...args) => {
    const outcome = await limiter.check(request);
    if (outcome.action === 'reject') return limiter.rejection(outcome);
    return limiter.applyHeaders(await handler(request, ...args), outcome);
  };
}
