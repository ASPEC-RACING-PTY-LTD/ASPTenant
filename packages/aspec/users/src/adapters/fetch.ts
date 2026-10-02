import { UsersError } from '../errors.js';
import {
  assertRouterOptions,
  createAdminRoutes,
  createSelfServiceRoutes,
  errorOutput,
  executeRoute,
  type HttpOutput,
  matchRoute,
  parseJsonBody,
  resolveBodyLimit,
  resolveSubject,
  toFetchResponse,
  type UsersRoute,
  type UsersRouterOptions,
} from '../http.js';
import type { UsersService } from '../service.js';

export interface FetchUsersHandlerOptions extends UsersRouterOptions<Request> {
  /** Path prefix where the handler is mounted, for example `/api/admin`. Default ``. */
  basePath?: string;
}

export type FetchHandler = (request: Request) => Promise<Response>;

function normaliseBase(base: string | undefined): string {
  if (base === undefined || base === '' || base === '/') return '';
  if (!base.startsWith('/')) {
    throw new UsersError('USERS_CONFIG_INVALID', 'basePath must start with /');
  }
  return base.replace(/\/+$/, '');
}

function createHandler(
  service: UsersService,
  routes: UsersRoute[],
  options: FetchUsersHandlerOptions,
): FetchHandler {
  const limit = resolveBodyLimit(options.bodyLimit);
  const base = normaliseBase(options.basePath);
  const notFound = (): Response =>
    toFetchResponse({
      status: 404,
      body: { error: { code: 'USERS_ROUTE_NOT_FOUND', message: 'Not found' } },
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
        body: { error: { code: 'USERS_METHOD_NOT_ALLOWED', message: 'Method not allowed' } },
      });
    }
    let out: HttpOutput;
    try {
      let body: unknown;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const declared = Number(request.headers.get('content-length') ?? '0');
        if (Number.isFinite(declared) && declared > limit) {
          throw new UsersError('USERS_PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`);
        }
        body = parseJsonBody(await request.text(), limit);
      }
      const ua = request.headers.get('user-agent');
      out = await executeRoute(
        service,
        match.route,
        {
          method: request.method,
          params: match.params,
          query: url.searchParams,
          body,
          header: (name) => request.headers.get(name) ?? undefined,
          actor: await resolveSubject(options.resolveActor, request),
          ...(ua === null ? {} : { userAgent: ua }),
        },
        options.logger,
      );
    } catch (err) {
      out = errorOutput(err, options.logger);
    }
    return toFetchResponse(out);
  };
}

/** Web Fetch API handler `(request) => Promise<Response>` for the admin API. */
export function createUsersAdminHandler(
  service: UsersService,
  options: FetchUsersHandlerOptions,
): FetchHandler {
  assertRouterOptions(service, options, 'admin');
  return createHandler(service, createAdminRoutes(service), options);
}

/** Web Fetch API handler for the self-service API. */
export function createUsersSelfServiceHandler(
  service: UsersService,
  options: FetchUsersHandlerOptions,
): FetchHandler {
  assertRouterOptions(service, options, 'self');
  return createHandler(service, createSelfServiceRoutes(service), options);
}
