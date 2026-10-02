import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  createHttpRateLimiter,
  type HttpRateLimiter,
  type HttpRateLimitOptions,
  type HttpRateLimitOutcome,
  nodeHeaderReader,
  PROBLEM_CONTENT_TYPE,
  pathOf,
} from '../http.js';

/** Per-route configuration: `false` disables limiting, an object replaces the global rules. */
export type FastifyRouteRateLimit = false | HttpRateLimitOptions;

declare module 'fastify' {
  interface FastifyContextConfig {
    rateLimit?: FastifyRouteRateLimit;
  }
  interface FastifyRequest {
    rateLimit?: HttpRateLimitOutcome;
  }
}

export interface FastifyRateLimitOptions extends HttpRateLimitOptions {
  /** Apply the global rules to every route. Default true. When false only routes with `config.rateLimit` are limited. */
  global?: boolean;
}

async function send(
  http: HttpRateLimiter,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  const outcome = await http.evaluate({
    method: request.method,
    path: pathOf(request.url),
    remoteAddress: request.raw.socket?.remoteAddress,
    header: nodeHeaderReader(request.headers),
    user: (request as FastifyRequest & { user?: unknown }).user,
    raw: request,
  });
  request.rateLimit = outcome;
  reply.headers(outcome.headers);
  if (outcome.action === 'reject') {
    reply
      .code(outcome.status)
      .header('Content-Type', PROBLEM_CONTENT_TYPE)
      .header('Cache-Control', 'no-store')
      .send(outcome.body);
    return reply;
  }
  return undefined;
}

const plugin: FastifyPluginAsync<FastifyRateLimitOptions> = async (app, options) => {
  const { global = true, ...rest } = options;
  const hasGlobalRules = (rest.rules?.length ?? 0) > 0 || rest.limiter !== undefined;
  const globalHttp = hasGlobalRules ? createHttpRateLimiter(rest) : undefined;
  const perRoute = new WeakMap<object, HttpRateLimiter>();
  const { rules: _rules, limiter: _limiter, key: _key, ...shared } = rest;

  app.addHook('onRequest', async (request, reply) => {
    const config = request.routeOptions.config?.rateLimit;
    if (config === false) return;
    if (config && typeof config === 'object') {
      let http = perRoute.get(config);
      if (!http) {
        http = createHttpRateLimiter({ ...shared, ...config });
        perRoute.set(config, http);
      }
      return send(http, request, reply);
    }
    if (global && globalHttp) return send(globalHttp, request, reply);
  });
};

// Equivalent of fastify-plugin: hooks apply to the parent scope instead of an encapsulated one.
(plugin as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true;
(plugin as unknown as Record<symbol, unknown>)[Symbol.for('fastify.display-name')] =
  '@aspec/rate-limit';

/**
 * Fastify plugin. Register with `app.register(fastifyRateLimit, options)`. Routes can set
 * `config: { rateLimit: false }` or `config: { rateLimit: { limiter } }`.
 */
export const fastifyRateLimit: FastifyPluginAsync<FastifyRateLimitOptions> = plugin;
