import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import type { Auth } from '../auth.js';
import { AuthError } from '../errors.js';
import {
  type AuthHttpHandler,
  type AuthHttpOptions,
  type AuthHttpRequest,
  type AuthHttpResponse,
  createAuthHttpHandler,
  type RequestAuth,
} from '../http.js';

export type { AuthHttpOptions, RequestAuth } from '../http.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireAuth from @aspec/auth/fastify. */
    auth: RequestAuth | null;
  }
}

export interface RequireAuthOptions {
  /** Continue with `request.auth = null` instead of responding 401. Default false. */
  optional?: boolean;
  /** Origin checks for state-changing cookie requests. Default true. */
  csrf?: boolean;
}

export interface FastifyAuthPlugin {
  (fastify: FastifyInstance): Promise<void>;
  readonly handler: AuthHttpHandler;
  /** preHandler hook that authenticates by session cookie or bearer token and sets `request.auth`. */
  requireAuth(options?: RequireAuthOptions): preHandlerAsyncHookHandler;
}

function toRequest(request: FastifyRequest): AuthHttpRequest {
  const out: AuthHttpRequest = {
    method: request.method,
    url: request.url,
    header: (name) => {
      const v = request.headers[name.toLowerCase()];
      if (Array.isArray(v)) return name.toLowerCase() === 'cookie' ? v.join('; ') : v[0];
      return v;
    },
  };
  if (request.ip) out.ip = request.ip;
  if (typeof request.body === 'string') out.body = request.body;
  return out;
}

function send(reply: FastifyReply, response: AuthHttpResponse) {
  reply.code(response.status);
  const cookies: string[] = [];
  for (const [name, value] of response.headers) {
    if (name === 'set-cookie') cookies.push(value);
    else reply.header(name, value);
  }
  if (cookies.length > 0) reply.header('set-cookie', cookies);
  return reply.send(response.body ?? '');
}

/**
 * Fastify 5 plugin exposing the @aspec/auth endpoints under `basePath`.
 * Register with `await app.register(plugin)`. Routes live in an encapsulated context with their
 * own raw body parser (limited to `maxBodyBytes`), so the application's parsers are untouched.
 */
export function createAuthPlugin(auth: Auth, options: AuthHttpOptions = {}): FastifyAuthPlugin {
  const handler = createAuthHttpHandler(auth, options);

  const plugin = (async (fastify: FastifyInstance) => {
    if (!fastify.hasRequestDecorator('auth')) fastify.decorateRequest('auth', null);
    await fastify.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser(
        '*',
        { parseAs: 'string', bodyLimit: handler.maxBodyBytes },
        (_req, body, done) => {
          done(null, body);
        },
      );
      scope.setErrorHandler((err: { statusCode?: number; code?: string }, _request, reply) => {
        const mapped =
          err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413
            ? new AuthError('AUTH_PAYLOAD_TOO_LARGE')
            : err.statusCode === 415
              ? new AuthError('AUTH_UNSUPPORTED_MEDIA_TYPE')
              : err;
        return send(reply, handler.errorResponse(mapped));
      });
      const route = async (request: FastifyRequest, reply: FastifyReply) => {
        const response = await handler.handle(toRequest(request));
        return send(reply, response ?? handler.errorResponse(new AuthError('AUTH_NOT_FOUND')));
      };
      const base = handler.basePath;
      scope.all(base === '' ? '/' : base, route);
      scope.all(`${base}/*`, route);
    });
  }) as FastifyAuthPlugin;

  // Equivalent of fastify-plugin: the request decorator is visible to the whole application.
  (plugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
  Object.defineProperty(plugin, 'handler', { value: handler });
  plugin.requireAuth = (opts: RequireAuthOptions = {}): preHandlerAsyncHookHandler => {
    return async function requireAuth(request, reply) {
      try {
        request.auth = await handler.authenticate(toRequest(request), {
          csrf: opts.csrf ?? true,
          optional: opts.optional ?? false,
        });
      } catch (err) {
        await send(reply, handler.errorResponse(err));
      }
    };
  };
  return plugin;
}

/** Returns the authentication set by requireAuth, or throws when the route is not protected. */
export function getAuth(request: FastifyRequest): RequestAuth {
  if (!request.auth) throw new Error('getAuth() called on a request without requireAuth()');
  return request.auth;
}
