import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  type AdminRouterOptions,
  createAdminRoutes,
  errorOutput,
  executeAdminRoute,
  type HttpOutput,
  PROBLEM_CONTENT_TYPE,
  type VerifyMiddlewareOptions,
  verifyRequest,
} from '../http.js';
import type { Subject } from '../ports.js';
import type { ApiKeys } from '../service.js';
import type { VerifiedPrincipal } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: VerifiedPrincipal;
  }
}

function send(reply: FastifyReply, out: HttpOutput): void {
  if (out.headers) {
    for (const [k, v] of Object.entries(out.headers)) reply.header(k, v);
  }
  reply.header('cache-control', 'no-store');
  if (out.body === undefined) reply.code(out.status).send();
  else {
    if (!out.headers?.['content-type']) reply.type('application/json');
    reply.code(out.status).send(out.body);
  }
}

export function createApiKeyPreHandler(api: ApiKeys, options: VerifyMiddlewareOptions = {}) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const opts: VerifyMiddlewareOptions & { ip?: string | null } = { ...options };
    if (request.ip !== undefined) opts.ip = request.ip;
    const outcome = await verifyRequest(
      api,
      (name) => {
        const v = request.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      },
      opts,
    );
    if (!outcome.ok) {
      send(reply, outcome.output);
      return reply;
    }
    request.apiKey = outcome.principal;
  };
}

export interface FastifyAdminOptions {
  authorize?: AdminRouterOptions['authorize'];
  resolveActor: (request: FastifyRequest) => Subject | Promise<Subject | undefined> | undefined;
  prefix?: string;
}

export const apiKeysAdminPlugin: FastifyPluginAsync<
  FastifyAdminOptions & { api: ApiKeys }
> = async (app, opts) => {
  const { api, resolveActor } = opts;
  const routes = createAdminRoutes(api);
  app.all('/*', async (request, reply) => {
    const url = request.url;
    const q = url.indexOf('?');
    const fullPath = q === -1 ? url : url.slice(0, q);
    const base = app.prefix.replace(/\/$/, '');
    const path = base && fullPath.startsWith(base) ? fullPath.slice(base.length) || '/' : fullPath;
    let out: HttpOutput;
    try {
      const adminOpts: AdminRouterOptions = {
        resolveActor: () => resolveActor(request),
      };
      if (opts.authorize) adminOpts.authorize = opts.authorize;
      out = await executeAdminRoute(
        api,
        routes,
        {
          method: request.method,
          path,
          params: {},
          query: new URLSearchParams(q === -1 ? '' : url.slice(q + 1)),
          body: request.body,
          header: (name) => {
            const v = request.headers[name.toLowerCase()];
            return Array.isArray(v) ? v[0] : v;
          },
          ip: request.ip,
        },
        adminOpts,
      );
    } catch (err) {
      out = errorOutput(err);
    }
    if (out.headers?.['content-type'] === PROBLEM_CONTENT_TYPE) {
      reply.type(PROBLEM_CONTENT_TYPE);
    }
    send(reply, out);
  });
};

(apiKeysAdminPlugin as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true;
