import { OrgsError } from '../errors.js';
import {
  assertRouterOptions,
  createAdminRoutes,
  createMemberRoutes,
  errorOutput,
  executeRoute,
  type HttpOutput,
  matchRoute,
  type OrgsRoute,
  type OrgsRouterOptions,
  parseJsonBody,
  resolveBodyLimit,
  resolveSubject,
  toFetchResponse,
} from '../http.js';
import type { OrgsService } from '../service.js';

export interface FetchOrgsHandlerOptions extends OrgsRouterOptions<Request> {
  basePath?: string;
}

export type FetchHandler = (request: Request) => Promise<Response>;

function normaliseBase(base: string | undefined): string {
  if (base === undefined || base === '' || base === '/') return '';
  if (!base.startsWith('/')) {
    throw new OrgsError('ORGS_CONFIG_INVALID', 'basePath must start with /');
  }
  return base.replace(/\/+$/, '');
}

function queryOf(url: URL): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length <= 1 ? all[0] : all;
  }
  return out;
}

function createHandler(
  service: OrgsService,
  routes: OrgsRoute[],
  options: FetchOrgsHandlerOptions,
): FetchHandler {
  const limit = resolveBodyLimit(options.bodyLimit);
  const base = normaliseBase(options.basePath);
  const notFound = (): Response =>
    toFetchResponse({
      status: 404,
      body: { error: { code: 'ORGS_ROUTE_NOT_FOUND', message: 'Not found' } },
    });
  return async (request) => {
    const url = new URL(request.url);
    let path = url.pathname;
    if (base) {
      if (path !== base && !path.startsWith(`${base}/`)) return notFound();
      path = path.slice(base.length) || '/';
    }
    const match = matchRoute(routes, request.method, path);
    if (!match) return notFound();
    if ('allowed' in match) {
      return toFetchResponse({
        status: 405,
        headers: { allow: match.allowed.join(', ') },
        body: { error: { code: 'ORGS_METHOD_NOT_ALLOWED', message: 'Method not allowed' } },
      });
    }
    let out: HttpOutput;
    try {
      let body: unknown;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const declared = Number(request.headers.get('content-length') ?? '0');
        if (Number.isFinite(declared) && declared > limit) {
          throw new OrgsError('ORGS_PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`);
        }
        body = parseJsonBody(await request.text(), limit);
      }
      const headers: Record<string, string | undefined> = {};
      request.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const actor = await resolveSubject(options, request);
      out = await executeRoute(
        match.route,
        {
          method: request.method,
          path,
          params: match.params,
          query: queryOf(url),
          body,
          headers,
          actor,
          subject: actor && 'orgId' in actor ? (actor as never) : null,
        },
        service,
      );
    } catch (err) {
      out = errorOutput(err, options.logger);
    }
    return toFetchResponse(out);
  };
}

export function createOrgsAdminHandler(
  service: OrgsService,
  options: FetchOrgsHandlerOptions,
): FetchHandler {
  assertRouterOptions(service, options);
  return createHandler(service, createAdminRoutes(), options);
}

export function createOrgsMemberHandler(
  service: OrgsService,
  options: FetchOrgsHandlerOptions,
): FetchHandler {
  assertRouterOptions(service, options);
  return createHandler(service, createMemberRoutes(), options);
}
