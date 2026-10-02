import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Api } from '../api.js';

export interface ExpressApiOptions {
  /** Mount path prefix already handled by Express router. Default strips nothing extra. */
  basePath?: string;
}

/**
 * Express 4 and 5 request handler that dispatches to an Api instance.
 * Mount error handling from `@aspec/errors/express` separately for uncaught errors.
 */
export function createExpressApi(api: Api, options: ExpressApiOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.get('host') ?? 'localhost';
    const proto = (req.protocol || 'http') as string;
    const url = `${proto}://${host}${req.originalUrl || req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const init: RequestInit = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
      init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
    const request = new Request(url, init);
    const path = options.basePath
      ? (req.originalUrl || req.url || '/').split('?')[0]!
      : req.path || '/';
    const handleOpts: Parameters<Api['handle']>[1] = {
      path,
      params: req.params as Record<string, string>,
      query: req.query as Record<string, string>,
      body: req.body,
    };
    const correlationId = res.locals.correlationId as string | undefined;
    if (correlationId !== undefined) handleOpts!.correlationId = correlationId;
    api
      .handle(request, handleOpts)
      .then(async (response) => {
        res.status(response.status);
        response.headers.forEach((value, key) => {
          res.setHeader(key, value);
        });
        const buf = Buffer.from(await response.arrayBuffer());
        res.end(buf);
      })
      .catch(next);
  };
}
