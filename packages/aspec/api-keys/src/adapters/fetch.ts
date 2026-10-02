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

export interface FetchVerifyOptions extends VerifyMiddlewareOptions {
  getIp?: (request: Request) => string | undefined;
}

export interface FetchVerifyResult {
  ok: true;
  principal: VerifiedPrincipal;
  request: Request;
}

export async function verifyFetchRequest(
  api: ApiKeys,
  request: Request,
  options: FetchVerifyOptions = {},
): Promise<FetchVerifyResult | Response> {
  const { getIp, ...rest } = options;
  const opts: VerifyMiddlewareOptions & { ip?: string | null } = { ...rest };
  const ip = getIp?.(request);
  if (ip !== undefined) opts.ip = ip;
  const outcome = await verifyRequest(api, (name) => request.headers.get(name) ?? undefined, opts);
  if (!outcome.ok) {
    return new Response(JSON.stringify(outcome.output.body ?? {}), {
      status: outcome.output.status,
      headers: {
        'Content-Type': PROBLEM_CONTENT_TYPE,
        'Cache-Control': 'no-store',
        ...(outcome.output.headers ?? {}),
      },
    });
  }
  return { ok: true, principal: outcome.principal, request };
}

export function withApiKeyAuth<Args extends unknown[]>(
  handler: (
    request: Request,
    principal: VerifiedPrincipal,
    ...args: Args
  ) => Response | Promise<Response>,
  api: ApiKeys,
  options: FetchVerifyOptions = {},
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request, ...args) => {
    const result = await verifyFetchRequest(api, request, options);
    if (result instanceof Response) return result;
    return handler(request, result.principal, ...args);
  };
}

export interface FetchAdminOptions {
  authorize?: AdminRouterOptions['authorize'];
  resolveActor: (request: Request) => Subject | Promise<Subject | undefined> | undefined;
  basePath?: string;
}

export function createApiKeysAdminHandler(
  api: ApiKeys,
  options: FetchAdminOptions,
): (request: Request) => Promise<Response> {
  const routes = createAdminRoutes(api);
  const base = options.basePath ?? '';
  return async (request) => {
    let out: HttpOutput;
    try {
      const url = new URL(request.url);
      let path = url.pathname;
      if (base && path.startsWith(base)) path = path.slice(base.length) || '/';
      let body: unknown;
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'DELETE') {
        const text = await request.text();
        body = text ? (JSON.parse(text) as unknown) : undefined;
      }
      const adminOpts: AdminRouterOptions = {
        resolveActor: () => options.resolveActor(request),
      };
      if (options.authorize) adminOpts.authorize = options.authorize;
      out = await executeAdminRoute(
        api,
        routes,
        {
          method: request.method,
          path,
          params: {},
          query: url.searchParams,
          body,
          header: (name) => request.headers.get(name) ?? undefined,
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
  };
}
