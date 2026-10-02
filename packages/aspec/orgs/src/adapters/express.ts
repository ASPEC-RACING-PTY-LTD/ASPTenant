import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
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
  resolveTenantRef,
} from '../http.js';
import type { OrgsService } from '../service.js';

export type ExpressOrgsRouterOptions = OrgsRouterOptions<Request>;

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > limit) {
      throw new OrgsError('ORGS_PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`);
    }
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
      throw new OrgsError('ORGS_PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`);
    }
    return parsed;
  }
  if (typeof parsed === 'string') return parseJsonBody(parsed, limit);
  if (parsed instanceof Uint8Array) {
    return parseJsonBody(Buffer.from(parsed).toString('utf8'), limit);
  }
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

function queryFromUrl(url: string): Record<string, string | string[] | undefined> {
  const qIndex = url.indexOf('?');
  const out: Record<string, string | string[] | undefined> = {};
  if (qIndex < 0) return out;
  const params = new URLSearchParams(url.slice(qIndex + 1));
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length <= 1 ? all[0] : all;
  }
  return out;
}

function createHandler(
  service: OrgsService,
  routes: OrgsRoute[],
  options: ExpressOrgsRouterOptions,
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
        body: { error: { code: 'ORGS_METHOD_NOT_ALLOWED', message: 'Method not allowed' } },
      });
      return;
    }
    const run = async () => {
      let out: HttpOutput;
      try {
        const actor = await resolveSubject(options, req);
        out = await executeRoute(
          match.route,
          {
            method: req.method,
            path: req.path,
            params: match.params,
            query: queryFromUrl(req.originalUrl),
            body: await bodyOf(req, limit),
            headers: req.headers as Record<string, string | string[] | undefined>,
            actor,
            subject: actor && 'orgId' in actor ? (actor as never) : null,
          },
          service,
        );
      } catch (err) {
        out = errorOutput(err, options.logger);
      }
      send(res, out);
    };
    run().catch(next);
  };
}

/** Express (4 and 5) middleware for organisation admin APIs. */
export function createOrgsAdminRouter(
  service: OrgsService,
  options: ExpressOrgsRouterOptions,
): RequestHandler {
  assertRouterOptions(service, options);
  return createHandler(service, createAdminRoutes(), options);
}

/** Express (4 and 5) middleware for member-facing organisation APIs. */
export function createOrgsMemberRouter(
  service: OrgsService,
  options: ExpressOrgsRouterOptions,
): RequestHandler {
  assertRouterOptions(service, options);
  return createHandler(service, createMemberRoutes(), options);
}

/**
 * Resolves tenant, verifies membership, and continues the chain inside `runWithTenant`
 * so `currentTenant()` / `requireTenant()` work in downstream handlers.
 */
export function createTenantMiddleware(
  service: OrgsService,
  options: ExpressOrgsRouterOptions & {
    resolveUserId: (req: Request) => string | null | Promise<string | null>;
  },
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      try {
        const userId = await options.resolveUserId(req);
        if (!userId) {
          send(res, errorOutput(new OrgsError('ORGS_UNAUTHENTICATED', 'Authentication required')));
          return;
        }
        const refInput: {
          headers: Record<string, string | string[] | undefined>;
          url: string;
          host?: string;
        } = {
          headers: req.headers as Record<string, string | string[] | undefined>,
          url: req.originalUrl,
        };
        if (req.headers.host) refInput.host = req.headers.host;
        const ref = await resolveTenantRef(options.tenant, refInput);
        const enter: { userId: string; orgId?: string; slug?: string } = { userId };
        if (ref?.orgId) enter.orgId = ref.orgId;
        if (ref?.slug) enter.slug = ref.slug;
        await service.enterTenant(enter, () => {
          next();
        });
      } catch (err) {
        if (!res.headersSent) send(res, errorOutput(err, options.logger));
        else next(err);
      }
    })();
  };
}
