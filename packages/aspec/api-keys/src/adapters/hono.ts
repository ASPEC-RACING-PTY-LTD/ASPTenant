import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
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

export type ApiKeyVariables = {
  apiKey: VerifiedPrincipal;
};

export function apiKeyMiddleware(
  api: ApiKeys,
  options: VerifyMiddlewareOptions & {
    getIp?: (c: Context) => string | undefined;
  } = {},
): MiddlewareHandler<{ Variables: ApiKeyVariables }> {
  return async (c, next) => {
    const { getIp, ...rest } = options;
    const opts: VerifyMiddlewareOptions & { ip?: string | null } = { ...rest };
    const ip = getIp?.(c);
    if (ip !== undefined) opts.ip = ip;
    const outcome = await verifyRequest(api, (name) => c.req.header(name) ?? undefined, opts);
    if (!outcome.ok) {
      const out = outcome.output;
      return new Response(JSON.stringify(out.body ?? {}), {
        status: out.status,
        headers: {
          'Content-Type': PROBLEM_CONTENT_TYPE,
          'Cache-Control': 'no-store',
          ...(out.headers ?? {}),
        },
      });
    }
    c.set('apiKey', outcome.principal);
    await next();
  };
}

export interface HonoAdminOptions {
  authorize?: AdminRouterOptions['authorize'];
  resolveActor: (c: Context) => Subject | Promise<Subject | undefined> | undefined;
}

export function createApiKeysAdminApp(api: ApiKeys, options: HonoAdminOptions): Hono {
  const app = new Hono();
  const routes = createAdminRoutes(api);
  app.all('*', async (c) => {
    let out: HttpOutput;
    try {
      const url = new URL(c.req.url);
      let body: unknown;
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'DELETE') {
        try {
          body = await c.req.json();
        } catch {
          body = undefined;
        }
      }
      const adminOpts: AdminRouterOptions = {
        resolveActor: () => options.resolveActor(c),
      };
      if (options.authorize) adminOpts.authorize = options.authorize;
      out = await executeAdminRoute(
        api,
        routes,
        {
          method: c.req.method,
          path: c.req.path,
          params: {},
          query: url.searchParams,
          body,
          header: (name) => c.req.header(name) ?? undefined,
        },
        adminOpts,
      );
    } catch (err) {
      out = errorOutput(err);
    }
    if (out.body === undefined) return new Response(null, { status: out.status });
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: {
        'Content-Type': out.headers?.['content-type'] ?? 'application/json',
        'Cache-Control': 'no-store',
        ...(out.headers ?? {}),
      },
    });
  });
  return app;
}
