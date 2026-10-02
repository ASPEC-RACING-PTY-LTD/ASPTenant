import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
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
  type UsersRoute,
  type UsersRouterOptions,
} from '../http.js';
import type { UsersService } from '../service.js';

export type ExpressUsersRouterOptions = UsersRouterOptions<Request>;

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > limit)
      throw new UsersError('USERS_PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function bodyOf(req: Request, limit: number): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const parsed: unknown = req.body;
  if (parsed !== undefined && !(parsed instanceof Uint8Array) && typeof parsed !== 'string') {
    const size = Buffer.byteLength(JSON.stringify(parsed) ?? '', 'utf8');
    if (size > limit) {
      throw new UsersError('USERS_PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`);
    }
    return parsed;
  }
  if (typeof parsed === 'string') return parseJsonBody(parsed, limit);
  if (parsed instanceof Uint8Array)
    return parseJsonBody(Buffer.from(parsed).toString('utf8'), limit);
  if (req.readableEnded) return undefined;
  return parseJsonBody(await readBody(req, limit), limit);
}

function send(res: Response, out: HttpOutput): void {
  res.status(out.status);
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
  if (out.body === undefined) res.end();
  else res.json(out.body);
}

function createHandler(
  service: UsersService,
  routes: UsersRoute[],
  options: ExpressUsersRouterOptions,
): RequestHandler {
  const limit = resolveBodyLimit(options.bodyLimit);
  return (req: Request, res: Response, next: NextFunction) => {
    const match = matchRoute(routes, req.method, req.path);
    if (!match) {
      next();
      return;
    }
    if ('allowed' in match) {
      res.setHeader('allow', match.allowed.join(', '));
      send(res, {
        status: 405,
        body: { error: { code: 'USERS_METHOD_NOT_ALLOWED', message: 'Method not allowed' } },
      });
      return;
    }
    const run = async () => {
      let out: HttpOutput;
      try {
        const qIndex = req.originalUrl.indexOf('?');
        const input = {
          method: req.method,
          params: match.params,
          query: new URLSearchParams(qIndex >= 0 ? req.originalUrl.slice(qIndex + 1) : ''),
          body: await bodyOf(req, limit),
          header: (name: string) => {
            const v = req.headers[name.toLowerCase()];
            return Array.isArray(v) ? v[0] : v;
          },
          actor: await resolveSubject(options.resolveActor, req),
          ...(req.ip === undefined ? {} : { ip: req.ip }),
          ...(req.headers['user-agent'] === undefined
            ? {}
            : { userAgent: req.headers['user-agent'] }),
        };
        out = await executeRoute(service, match.route, input, options.logger);
      } catch (err) {
        out = errorOutput(err, options.logger);
      }
      send(res, out);
    };
    run().catch(next);
  };
}

/**
 * Express (4 and 5) middleware serving the admin API. Mount it with
 * `app.use('/admin', createUsersAdminRouter(users, { resolveActor }))`.
 * Works with or without `express.json()`; unmatched paths call `next()`.
 */
export function createUsersAdminRouter(
  service: UsersService,
  options: ExpressUsersRouterOptions,
): RequestHandler {
  assertRouterOptions(service, options, 'admin');
  return createHandler(service, createAdminRoutes(service), options);
}

/** Express (4 and 5) middleware serving the self-service API (`/me`, `/activate`, ...). */
export function createUsersSelfServiceRouter(
  service: UsersService,
  options: ExpressUsersRouterOptions,
): RequestHandler {
  assertRouterOptions(service, options, 'self');
  return createHandler(service, createSelfServiceRoutes(service), options);
}
