import { type Context, Hono } from 'hono';
import { UsersError } from '../errors.js';
import {
  assertRouterOptions,
  createAdminRoutes,
  createSelfServiceRoutes,
  errorOutput,
  executeRoute,
  type HttpOutput,
  parseJsonBody,
  resolveBodyLimit,
  resolveSubject,
  toFetchResponse,
  type UsersRoute,
  type UsersRouterOptions,
} from '../http.js';
import type { UsersService } from '../service.js';

export type HonoUsersRouterOptions = UsersRouterOptions<Context>;

async function readBody(c: Context, limit: number): Promise<unknown> {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return undefined;
  const declared = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    throw new UsersError('USERS_PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`);
  }
  return parseJsonBody(await c.req.text(), limit);
}

function createApp(
  service: UsersService,
  routes: UsersRoute[],
  options: HonoUsersRouterOptions,
): Hono {
  const limit = resolveBodyLimit(options.bodyLimit);
  const app = new Hono();
  for (const route of routes) {
    app.on(route.method, route.path, async (c) => {
      let out: HttpOutput;
      try {
        const ua = c.req.header('user-agent');
        out = await executeRoute(
          service,
          route,
          {
            method: c.req.method,
            params: c.req.param() as Record<string, string>,
            query: new URL(c.req.url).searchParams,
            body: await readBody(c, limit),
            header: (name) => c.req.header(name),
            actor: await resolveSubject(options.resolveActor, c),
            ...(ua === undefined ? {} : { userAgent: ua }),
          },
          options.logger,
        );
      } catch (err) {
        out = errorOutput(err, options.logger);
      }
      return toFetchResponse(out);
    });
  }
  return app;
}

/** Hono 4 sub-application serving the admin API: `app.route('/admin', createUsersAdminApp(...))`. */
export function createUsersAdminApp(service: UsersService, options: HonoUsersRouterOptions): Hono {
  assertRouterOptions(service, options, 'admin');
  return createApp(service, createAdminRoutes(service), options);
}

/** Hono 4 sub-application serving the self-service API. */
export function createUsersSelfServiceApp(
  service: UsersService,
  options: HonoUsersRouterOptions,
): Hono {
  assertRouterOptions(service, options, 'self');
  return createApp(service, createSelfServiceRoutes(service), options);
}
