import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Rbac } from '../engine.js';
import { isRbacError, RbacNotFoundError } from '../errors.js';
import {
  createRbacAdminHttp,
  parseJsonBody,
  type RbacAdminHttpOptions,
} from '../http/admin-http.js';
import { createGuards, type GuardOptions } from '../http/guard.js';
import { PROBLEM_CONTENT_TYPE, toProblem } from '../http/problem.js';
import type { Subject } from '../ports.js';

export type { GuardOptions } from '../http/guard.js';
export type ExpressRbacAdminOptions = RbacAdminHttpOptions<Request>;

declare global {
  namespace Express {
    interface Request {
      /** Subject attached by @aspec/rbac/express middleware after a successful check. */
      rbac?: { subject: Subject };
    }
  }
}

function sendProblem(res: Response, err: unknown): void {
  const problem = toProblem(err);
  res.status(problem.status);
  res.setHeader('content-type', PROBLEM_CONTENT_TYPE);
  res.setHeader('cache-control', 'no-store');
  res.json(problem);
}

function readBody(req: Request, limit: number): Promise<unknown> {
  if (req.body !== undefined) return Promise.resolve(req.body);
  if (req.readableEnded) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > limit) {
        failed = true;
        reject(
          Object.assign(new Error(`request body exceeds ${limit} bytes`), {
            code: 'RBAC_PAYLOAD_TOO_LARGE',
            status: 413,
            expose: true,
          }),
        );
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        resolve(parseJsonBody(Buffer.concat(chunks).toString('utf8'), limit));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

function wrap(run: (req: Request) => Promise<Subject>): RequestHandler {
  return (req, res, next) => {
    run(req)
      .then((subject) => {
        req.rbac = { subject };
        next();
      })
      .catch((err: unknown) => {
        if (isRbacError(err) && err.expose) {
          sendProblem(res, err);
          return;
        }
        next(err);
      });
  };
}

/** Express middleware factory for permission and role guards. */
export function createRbacMiddleware(rbac: Rbac) {
  const guards = createGuards(rbac);
  return {
    requirePermission(permission: string, options: GuardOptions<Request>): RequestHandler {
      return wrap((req) => guards.requirePermission(permission, req, options));
    },
    requireRole(role: string, options: GuardOptions<Request>): RequestHandler {
      return wrap((req) => guards.requireRole(role, req, options));
    },
    requireAny(permissions: readonly string[], options: GuardOptions<Request>): RequestHandler {
      return wrap((req) => guards.requireAny(permissions, req, options));
    },
    requireAll(permissions: readonly string[], options: GuardOptions<Request>): RequestHandler {
      return wrap((req) => guards.requireAll(permissions, req, options));
    },
  };
}

/**
 * Express 4 and 5 middleware serving the RBAC admin API.
 * Mount under a prefix: `app.use('/admin/rbac', createRbacAdminRouter(rbac, options))`.
 */
export function createRbacAdminRouter(
  rbac: Rbac,
  options: ExpressRbacAdminOptions,
): RequestHandler {
  const http = createRbacAdminHttp<Request>(rbac, options);
  return (req: Request, res: Response, next: NextFunction) => {
    const m = http.match(req.method, req.path);
    if (!m) {
      sendProblem(res, new RbacNotFoundError('RBAC_ROUTE_NOT_FOUND', 'Not found'));
      return;
    }
    const url = new URL(req.originalUrl || req.url, 'http://localhost');
    http
      .handle(m.route, {
        request: req,
        params: m.params,
        query: url.searchParams,
        contentType: req.headers['content-type'],
        readBody: () => readBody(req, http.bodyLimitBytes),
      })
      .then((r) => {
        for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
        res.status(r.status);
        if (r.body === undefined) res.end();
        else res.json(r.body);
      })
      .catch((err: unknown) => {
        if (isRbacError(err) && err.expose) {
          sendProblem(res, err);
          return;
        }
        next(err);
      });
  };
}
