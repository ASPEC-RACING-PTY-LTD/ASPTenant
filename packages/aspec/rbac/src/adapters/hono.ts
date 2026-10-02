import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { Rbac } from '../engine.js';
import { isRbacError } from '../errors.js';
import {
  createRbacAdminHttp,
  parseJsonBody,
  type RbacAdminHttpOptions,
} from '../http/admin-http.js';
import { createGuards, type GuardOptions } from '../http/guard.js';
import { PROBLEM_CONTENT_TYPE, toProblem } from '../http/problem.js';
import type { Subject } from '../ports.js';

export type { GuardOptions } from '../http/guard.js';

type RbacEnv = { Variables: { rbac: { subject: Subject } } };

export type HonoRbacAdminOptions = RbacAdminHttpOptions<Context<RbacEnv>>;

declare module 'hono' {
  interface ContextVariableMap {
    rbac: { subject: Subject };
  }
}

function problemResponse(err: unknown): Response {
  const problem = toProblem(err);
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: {
      'content-type': PROBLEM_CONTENT_TYPE,
      'cache-control': 'no-store',
    },
  });
}

function wrap(run: (c: Context<RbacEnv>) => Promise<Subject>): MiddlewareHandler<RbacEnv> {
  return async (c, next) => {
    try {
      const subject = await run(c);
      c.set('rbac', { subject });
      await next();
    } catch (err) {
      if (isRbacError(err) && err.expose) return problemResponse(err);
      throw err;
    }
  };
}

/** Hono middleware factory for permission and role guards. */
export function createRbacMiddleware(rbac: Rbac) {
  const guards = createGuards(rbac);
  return {
    requirePermission(
      permission: string,
      options: GuardOptions<Context<RbacEnv>>,
    ): MiddlewareHandler<RbacEnv> {
      return wrap((c) => guards.requirePermission(permission, c, options));
    },
    requireRole(role: string, options: GuardOptions<Context<RbacEnv>>): MiddlewareHandler<RbacEnv> {
      return wrap((c) => guards.requireRole(role, c, options));
    },
    requireAny(
      permissions: readonly string[],
      options: GuardOptions<Context<RbacEnv>>,
    ): MiddlewareHandler<RbacEnv> {
      return wrap((c) => guards.requireAny(permissions, c, options));
    },
    requireAll(
      permissions: readonly string[],
      options: GuardOptions<Context<RbacEnv>>,
    ): MiddlewareHandler<RbacEnv> {
      return wrap((c) => guards.requireAll(permissions, c, options));
    },
  };
}

/**
 * Hono app serving the RBAC admin API. Mount with `app.route('/admin/rbac', createRbacAdminApp(rbac, options))`.
 */
export function createRbacAdminApp(rbac: Rbac, options: HonoRbacAdminOptions): Hono<RbacEnv> {
  const http = createRbacAdminHttp<Context<RbacEnv>>(rbac, options);
  const app = new Hono<RbacEnv>();
  for (const route of http.routes) {
    app.on(route.method, route.pattern, async (c) => {
      try {
        const url = new URL(c.req.url);
        const r = await http.handle(route, {
          request: c,
          params: c.req.param() as Record<string, string>,
          query: url.searchParams,
          contentType: c.req.header('content-type'),
          readBody: async () => {
            const text = await c.req.text();
            return parseJsonBody(text, http.bodyLimitBytes);
          },
        });
        if (r.body === undefined)
          return new Response(null, { status: r.status, headers: r.headers });
        return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
      } catch (err) {
        if (isRbacError(err) && err.expose) return problemResponse(err);
        throw err;
      }
    });
  }
  return app;
}
