import type { Context, MiddlewareHandler } from 'hono';
import {
  createHttpRateLimiter,
  type HttpRateLimiter,
  type HttpRateLimitOptions,
  type HttpRateLimitOutcome,
  PROBLEM_CONTENT_TYPE,
  problemBody,
} from '../http.js';

export interface HonoRateLimitOptions extends HttpRateLimitOptions {
  /**
   * Returns the directly connected peer address. Default: `c.env.incoming.socket.remoteAddress`
   * (set by @hono/node-server). Other runtimes must provide this, for example with Hono's
   * `getConnInfo` helper for the runtime.
   */
  getRemoteAddress?: (c: Context) => string | undefined;
  /** Returns the authenticated user for `keys.user()`. Default `c.get('user')`. */
  getUser?: (c: Context) => unknown;
}

export interface RateLimitVariables {
  rateLimit: HttpRateLimitOutcome;
}

function defaultRemoteAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

/** Hono middleware. The outcome is available as `c.get('rateLimit')`. */
export function rateLimit(
  options: HonoRateLimitOptions,
): MiddlewareHandler<{ Variables: RateLimitVariables }> {
  const { getRemoteAddress = defaultRemoteAddress, getUser, ...rest } = options;
  const http: HttpRateLimiter = createHttpRateLimiter(rest);
  return async (c, next) => {
    const outcome = await http.evaluate({
      method: c.req.method,
      path: c.req.path,
      remoteAddress: getRemoteAddress(c),
      header: (name) => c.req.header(name) ?? undefined,
      user: getUser ? getUser(c) : (c.get as (key: string) => unknown)('user'),
      raw: c,
    });
    c.set('rateLimit', outcome);
    if (outcome.action === 'reject') {
      return new Response(problemBody(outcome), {
        status: outcome.status,
        headers: {
          ...outcome.headers,
          'Content-Type': PROBLEM_CONTENT_TYPE,
          'Cache-Control': 'no-store',
        },
      });
    }
    for (const [name, value] of Object.entries(outcome.headers)) c.header(name, value);
    await next();
    return undefined;
  };
}
