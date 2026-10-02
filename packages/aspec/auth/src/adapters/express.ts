import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Auth } from '../auth.js';
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

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth from @aspec/auth/express. */
      auth?: RequestAuth | null;
    }
  }
}

/** Structural Express request (Express 4 and 5 requests satisfy it). */
export type ExpressLikeRequest = IncomingMessage & {
  ip?: string | undefined;
  originalUrl?: string;
  body?: unknown;
  auth?: RequestAuth | null;
};
export type ExpressLikeResponse = ServerResponse;
export type ExpressLikeNext = (err?: unknown) => void;
export type ExpressMiddleware = (
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  next: ExpressLikeNext,
) => void;

export interface RequireAuthOptions {
  /** Continue with `req.auth = null` instead of responding 401. Default false. */
  optional?: boolean;
  /** Origin checks for state-changing cookie requests. Default true. */
  csrf?: boolean;
}

export interface ExpressAuthRouter extends ExpressMiddleware {
  readonly handler: AuthHttpHandler;
  /** Middleware that authenticates by session cookie or bearer token and sets `req.auth`. */
  requireAuth(options?: RequireAuthOptions): ExpressMiddleware;
}

function headerReader(req: IncomingMessage) {
  return (name: string): string | undefined => {
    const v = req.headers[name.toLowerCase()];
    if (Array.isArray(v)) return name.toLowerCase() === 'cookie' ? v.join('; ') : v[0];
    return v;
  };
}

function toRequest(req: ExpressLikeRequest): AuthHttpRequest {
  const out: AuthHttpRequest = {
    method: req.method ?? 'GET',
    url: req.originalUrl ?? req.url ?? '/',
    header: headerReader(req),
  };
  const ip = req.ip ?? req.socket?.remoteAddress;
  if (ip) out.ip = ip;
  return out;
}

function send(res: ServerResponse, method: string, response: AuthHttpResponse) {
  res.statusCode = response.status;
  const cookies: string[] = [];
  for (const [name, value] of response.headers) {
    if (name === 'set-cookie') cookies.push(value);
    else res.setHeader(name, value);
  }
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  res.end(method === 'HEAD' ? undefined : response.body);
}

/**
 * Express router (Express 4 and 5) exposing the @aspec/auth endpoints under `basePath`.
 * Mount with `app.use(router)`; it reads JSON bodies itself with a size limit, or uses
 * `req.body` when an upstream body parser already consumed the stream.
 */
export function createAuthRouter(auth: Auth, options: AuthHttpOptions = {}): ExpressAuthRouter {
  const handler = createAuthHttpHandler(auth, options);

  const router = ((req, res, next) => {
    const path = (req.originalUrl ?? req.url ?? '/').split('?')[0] ?? '/';
    if (!handler.matches(path)) {
      next();
      return;
    }
    const run = async () => {
      const request = toRequest(req);
      const method = request.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        if (req.readableEnded || (req as { _body?: boolean })._body === true) {
          request.parsedBody = req.body ?? {};
        } else {
          request.body = await readLimitedBody(
            req,
            handler.maxBodyBytes,
            req.headers['content-length'],
          );
        }
      }
      const response = await handler.handle(request);
      if (!response) {
        next();
        return;
      }
      send(res, method, response);
    };
    run().catch((err: unknown) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      send(res, req.method ?? 'GET', handler.errorResponse(err));
    });
  }) as ExpressAuthRouter;

  Object.defineProperty(router, 'handler', { value: handler });
  router.requireAuth = (opts: RequireAuthOptions = {}): ExpressMiddleware => {
    return (req, res, next) => {
      handler
        .authenticate(toRequest(req), { csrf: opts.csrf ?? true, optional: opts.optional ?? false })
        .then((result) => {
          req.auth = result;
          next();
        })
        .catch((err: unknown) => send(res, req.method ?? 'GET', handler.errorResponse(err)));
    };
  };
  return router;
}

/** Returns the authentication set by requireAuth, or throws when the route is not protected. */
export function getAuth(req: { auth?: RequestAuth | null }): RequestAuth {
  if (!req.auth) throw new Error('getAuth() called on a request without requireAuth()');
  return req.auth;
}
