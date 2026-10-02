import type { Auth } from '../auth.js';
import { AuthError } from '../errors.js';
import {
  type AuthHttpHandler,
  type AuthHttpOptions,
  type AuthHttpRequest,
  type AuthHttpResponse,
  createAuthHttpHandler,
  type RequestAuth,
  readLimitedBody,
} from '../http.js';

export type { AuthHttpOptions, RequestAuth } from '../http.js';

export interface FetchAuthOptions extends AuthHttpOptions {
  /** Returns the client IP for a request. Default: undefined (IP rate limiting is then skipped). */
  getClientIp?: (request: Request) => string | undefined;
}

export interface RequireAuthOptions {
  /** Pass `null` to the handler instead of responding 401. Default false. */
  optional?: boolean;
  /** Origin checks for state-changing cookie requests. Default true. */
  csrf?: boolean;
}

export interface FetchAuthHandler {
  /** Handles a request; responds 404 problem+json for paths outside basePath. */
  (request: Request): Promise<Response>;
  readonly handler: AuthHttpHandler;
  /** Handles a request under basePath, or resolves undefined so the caller can route it elsewhere. */
  handle(request: Request): Promise<Response | undefined>;
  /** Authenticates by session cookie or bearer token. */
  authenticate(request: Request, options?: RequireAuthOptions): Promise<RequestAuth | null>;
  /** Wraps a route handler so it only runs for authenticated requests. */
  requireAuth(
    fn: (request: Request, auth: RequestAuth) => Promise<Response> | Response,
    options?: { csrf?: boolean },
  ): (request: Request) => Promise<Response>;
}

function toResponse(response: AuthHttpResponse, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of response.headers) headers.append(name, value);
  const body =
    method === 'HEAD' || response.status === 204 || response.status === 302
      ? null
      : (response.body ?? null);
  return new Response(body, { status: response.status, headers });
}

/**
 * Web Fetch API handler `(request: Request) => Promise<Response>` exposing the @aspec/auth
 * endpoints. Usable from runtimes and frameworks that expose the Fetch API.
 */
export function createAuthFetchHandler(
  auth: Auth,
  options: FetchAuthOptions = {},
): FetchAuthHandler {
  const handler = createAuthHttpHandler(auth, options);
  const getIp = options.getClientIp;

  const toRequest = (request: Request): AuthHttpRequest => {
    const url = new URL(request.url);
    const out: AuthHttpRequest = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      header: (name) => request.headers.get(name) ?? undefined,
    };
    const ip = getIp?.(request);
    if (ip) out.ip = ip;
    return out;
  };

  const handle = async (request: Request): Promise<Response | undefined> => {
    const req = toRequest(request);
    if (!handler.matches(new URL(request.url).pathname)) return undefined;
    try {
      const method = req.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        req.body = await readLimitedBody(
          request.body,
          handler.maxBodyBytes,
          request.headers.get('content-length'),
        );
      }
      const response = await handler.handle(req);
      return response ? toResponse(response, method) : undefined;
    } catch (err) {
      return toResponse(handler.errorResponse(err), req.method);
    }
  };

  const fn = (async (request: Request) =>
    (await handle(request)) ??
    toResponse(
      handler.errorResponse(new AuthError('AUTH_NOT_FOUND')),
      request.method,
    )) as FetchAuthHandler;
  Object.defineProperty(fn, 'handler', { value: handler });
  fn.handle = handle;
  fn.authenticate = (request, opts = {}) =>
    handler.authenticate(toRequest(request), {
      csrf: opts.csrf ?? true,
      optional: opts.optional ?? false,
    });
  fn.requireAuth =
    (route, opts = {}) =>
    async (request) => {
      let result: RequestAuth | null;
      try {
        result = await handler.authenticate(toRequest(request), { csrf: opts.csrf ?? true });
      } catch (err) {
        return toResponse(handler.errorResponse(err), request.method);
      }
      return route(request, result as RequestAuth);
    };
  return fn;
}
