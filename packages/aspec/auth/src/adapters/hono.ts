import { type Context, Hono, type MiddlewareHandler } from 'hono';
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

/** Context variables set by requireAuth. Use as `new Hono<{ Variables: AuthVariables }>()`. */
export type AuthVariables = { auth: RequestAuth | null };

export interface HonoAuthOptions extends AuthHttpOptions {
  /**
   * Returns the client IP. Default: the socket address when running on @hono/node-server
   * (`c.env.incoming`), otherwise undefined (IP rate limiting is then skipped).
   */
  getClientIp?: (c: Context) => string | undefined;
}

export interface RequireAuthOptions {
  /** Continue with `c.get('auth') === null` instead of responding 401. Default false. */
  optional?: boolean;
  /** Origin checks for state-changing cookie requests. Default true. */
  csrf?: boolean;
}

export interface HonoAuthRoutes {
  /** Hono app with the endpoints under basePath. Mount with `app.route('/', routes.app)`. */
  readonly app: Hono;
  readonly handler: AuthHttpHandler;
  requireAuth(options?: RequireAuthOptions): MiddlewareHandler<{ Variables: AuthVariables }>;
}

function defaultClientIp(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
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

/** Hono 4 routes exposing the @aspec/auth endpoints and a typed requireAuth middleware. */
export function createAuthRoutes(auth: Auth, options: HonoAuthOptions = {}): HonoAuthRoutes {
  const handler = createAuthHttpHandler(auth, options);
  const getIp = options.getClientIp ?? defaultClientIp;

  const toRequest = (c: Context): AuthHttpRequest => {
    const url = new URL(c.req.url);
    const out: AuthHttpRequest = {
      method: c.req.method,
      url: `${url.pathname}${url.search}`,
      header: (name) => c.req.header(name) ?? undefined,
    };
    const ip = getIp(c);
    if (ip) out.ip = ip;
    return out;
  };

  const app = new Hono();
  const route = async (c: Context) => {
    const request = toRequest(c);
    try {
      const method = request.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        request.body = await readLimitedBody(
          c.req.raw.body,
          handler.maxBodyBytes,
          c.req.header('content-length'),
        );
      }
      const response = await handler.handle(request);
      return toResponse(response ?? handler.errorResponse(new AuthError('AUTH_NOT_FOUND')), method);
    } catch (err) {
      return toResponse(handler.errorResponse(err), request.method);
    }
  };
  const base = handler.basePath;
  app.all(base === '' ? '/' : base, route);
  app.all(`${base}/*`, route);

  return {
    app,
    handler,
    requireAuth(opts: RequireAuthOptions = {}) {
      return async (c, next) => {
        try {
          c.set(
            'auth',
            await handler.authenticate(toRequest(c), {
              csrf: opts.csrf ?? true,
              optional: opts.optional ?? false,
            }),
          );
        } catch (err) {
          return toResponse(handler.errorResponse(err), c.req.method);
        }
        await next();
        return undefined;
      };
    },
  };
}
