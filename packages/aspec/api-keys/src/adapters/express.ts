import type { IncomingMessage } from 'node:http';
import type { Request, RequestHandler, Response } from 'express';
import { ApiKeysError } from '../errors.js';
import {
  type AdminRouterOptions,
  createAdminRoutes,
  errorOutput,
  executeAdminRoute,
  type HttpOutput,
  type VerifyMiddlewareOptions,
  verifyRequest,
} from '../http.js';
import type { Subject } from '../ports.js';
import type { ApiKeys } from '../service.js';
import type { VerifiedPrincipal } from '../types.js';

declare global {
  namespace Express {
    interface Request {
      apiKey?: VerifiedPrincipal;
    }
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > limit) {
      throw new ApiKeysError('API_KEYS_PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`, {
        status: 413,
        expose: true,
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(raw: string, limit: number): unknown {
  if (Buffer.byteLength(raw, 'utf8') > limit) {
    throw new ApiKeysError('API_KEYS_PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`, {
      status: 413,
      expose: true,
    });
  }
  if (raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiKeysError('API_KEYS_VALIDATION', 'Invalid JSON body', {
      status: 400,
      expose: true,
    });
  }
}

async function bodyOf(req: Request, limit: number): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return undefined;
  const parsed: unknown = req.body;
  if (parsed !== undefined && !(parsed instanceof Uint8Array) && typeof parsed !== 'string') {
    return parsed;
  }
  if (typeof parsed === 'string') return parseJson(parsed, limit);
  if (parsed instanceof Uint8Array) return parseJson(Buffer.from(parsed).toString('utf8'), limit);
  if (req.readableEnded) return undefined;
  return parseJson(await readBody(req, limit), limit);
}

function send(res: Response, out: HttpOutput): void {
  res.status(out.status);
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
  if (out.body === undefined) res.end();
  else res.json(out.body);
}

export function createApiKeyMiddleware(
  api: ApiKeys,
  options: VerifyMiddlewareOptions = {},
): RequestHandler {
  return (req, res, next) => {
    const opts: VerifyMiddlewareOptions & { ip?: string | null } = { ...options };
    if (req.ip !== undefined) opts.ip = req.ip;
    verifyRequest(
      api,
      (name) => {
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      },
      opts,
    )
      .then((outcome) => {
        if (!outcome.ok) {
          send(res, outcome.output);
          return;
        }
        req.apiKey = outcome.principal;
        next();
      })
      .catch(next);
  };
}

export function createApiKeysAdminRouter(
  api: ApiKeys,
  options: {
    authorize?: AdminRouterOptions['authorize'];
    resolveActor: (req: Request) => Subject | Promise<Subject | undefined> | undefined;
    bodyLimit?: number;
  },
): RequestHandler {
  const routes = createAdminRoutes(api);
  const limit = options.bodyLimit ?? 65_536;
  return (req, res, next) => {
    const run = async () => {
      let out: HttpOutput;
      try {
        const qIndex = req.originalUrl.indexOf('?');
        const adminOpts: AdminRouterOptions = {
          resolveActor: () => options.resolveActor(req),
        };
        if (options.authorize) adminOpts.authorize = options.authorize;
        const input: Parameters<typeof executeAdminRoute>[2] = {
          method: req.method,
          path: req.path,
          params: {},
          query: new URLSearchParams(qIndex >= 0 ? req.originalUrl.slice(qIndex + 1) : ''),
          body: await bodyOf(req, limit),
          header: (name) => {
            const v = req.headers[name.toLowerCase()];
            return Array.isArray(v) ? v[0] : v;
          },
        };
        if (req.ip !== undefined) input.ip = req.ip;
        out = await executeAdminRoute(api, routes, input, adminOpts);
      } catch (err) {
        out = errorOutput(err);
      }
      send(res, out);
    };
    run().catch(next);
  };
}
