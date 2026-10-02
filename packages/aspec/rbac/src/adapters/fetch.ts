import type { Rbac } from '../engine.js';
import { isRbacError, RbacNotFoundError } from '../errors.js';
import {
  createRbacAdminHttp,
  parseJsonBody,
  type RbacAdminHttpOptions,
} from '../http/admin-http.js';
import { createGuards, type GuardOptions } from '../http/guard.js';
import { PROBLEM_CONTENT_TYPE, toProblem } from '../http/problem.js';
import type { Subject } from '../ports.js';

export type { GuardOptions } from '../http/guard.js';
export type FetchRbacAdminOptions = RbacAdminHttpOptions<Request> & {
  /** Path prefix stripped before matching routes. Default `/`. */
  basePath?: string;
};

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

export interface FetchGuardResult {
  subject: Subject;
  /** Present when the guard denied the request (401 or 403). */
  response?: Response;
}

/** Web Fetch API guards. Return a Response on denial; otherwise the subject. */
export function createRbacFetchGuards(rbac: Rbac) {
  const guards = createGuards(rbac);
  const run = async (fn: () => Promise<Subject>): Promise<FetchGuardResult> => {
    try {
      return { subject: await fn() };
    } catch (err) {
      if (isRbacError(err) && err.expose)
        return { subject: { id: '' }, response: problemResponse(err) };
      throw err;
    }
  };
  return {
    requirePermission(permission: string, request: Request, options: GuardOptions<Request>) {
      return run(() => guards.requirePermission(permission, request, options));
    },
    requireRole(role: string, request: Request, options: GuardOptions<Request>) {
      return run(() => guards.requireRole(role, request, options));
    },
    requireAny(permissions: readonly string[], request: Request, options: GuardOptions<Request>) {
      return run(() => guards.requireAny(permissions, request, options));
    },
    requireAll(permissions: readonly string[], request: Request, options: GuardOptions<Request>) {
      return run(() => guards.requireAll(permissions, request, options));
    },
  };
}

/**
 * Web Fetch handler for the RBAC admin API.
 * Suitable for Next.js route handlers and other Fetch-based runtimes.
 */
export function createRbacAdminFetchHandler(
  rbac: Rbac,
  options: FetchRbacAdminOptions,
): (request: Request) => Promise<Response> {
  const http = createRbacAdminHttp<Request>(rbac, options);
  const basePath = (options.basePath ?? '/').replace(/\/$/, '') || '';

  return async (request: Request) => {
    const url = new URL(request.url);
    let path = url.pathname;
    if (basePath && path.startsWith(basePath)) path = path.slice(basePath.length) || '/';
    const m = http.match(request.method, path);
    if (!m) return problemResponse(new RbacNotFoundError('RBAC_ROUTE_NOT_FOUND', 'Not found'));
    try {
      const r = await http.handle(m.route, {
        request,
        params: m.params,
        query: url.searchParams,
        contentType: request.headers.get('content-type') ?? undefined,
        readBody: async () => {
          const text = await request.text();
          return parseJsonBody(text, http.bodyLimitBytes);
        },
      });
      if (r.body === undefined) return new Response(null, { status: r.status, headers: r.headers });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
    } catch (err) {
      if (isRbacError(err) && err.expose) return problemResponse(err);
      throw err;
    }
  };
}
