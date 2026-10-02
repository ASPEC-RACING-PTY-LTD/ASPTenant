import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import {
  createErrorHandler,
  type ErrorHandler,
  type ErrorHandlerOptions,
  type ErrorRequestInfo,
} from '../handler.js';

export interface ExpressErrorHandling {
  readonly handler: ErrorHandler;
  /** Resolves the correlation ID, sets the response header and runs the request in context. Mount first. */
  readonly requestContext: RequestHandler;
  /** 404 handler for unmatched routes. Mount after all routes. */
  readonly notFound: RequestHandler;
  /** Four-argument error handler. Mount last. */
  readonly errorHandler: ErrorRequestHandler;
  /** Correlation ID assigned to a request by `requestContext`. */
  correlationId(req: Request): string | undefined;
}

function isHandler(v: ErrorHandlerOptions | ErrorHandler): v is ErrorHandler {
  return typeof (v as ErrorHandler).handle === 'function' && 'correlation' in v;
}

function pathOf(req: Request): string {
  const url = req.originalUrl || req.url || '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Express 4 and 5 error handling: correlation middleware, not-found handler and the
 * four-argument error handler. Express 5 forwards rejected promises from async handlers
 * automatically; on Express 4 wrap async handlers with `asyncHandler`.
 */
export function createExpressErrorHandling(
  options: ErrorHandlerOptions | ErrorHandler = {},
): ExpressErrorHandling {
  const handler = isHandler(options) ? options : createErrorHandler(options);
  const ids = new WeakMap<Request, string>();
  const header = handler.correlation.header;

  const info = (req: Request): ErrorRequestInfo => ({
    method: req.method,
    path: pathOf(req),
    correlationId: ids.get(req),
  });

  const send = (res: Response, r: ReturnType<ErrorHandler['handle']>): void => {
    res.status(r.status);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    res.end(handler.serialize(r));
  };

  const requestContext: RequestHandler = (req, res, next) => {
    const id = handler.correlation.resolve(req.headers[header]);
    ids.set(req, id);
    res.locals.correlationId = id;
    res.setHeader(header, id);
    handler.correlation.run(id, () => next());
  };

  const notFound: RequestHandler = (req, res) => {
    send(res, handler.notFound(info(req)));
  };

  const errorHandler: ErrorRequestHandler = (
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (res.headersSent) {
      handler.handle(err, info(req));
      next(err);
      return;
    }
    send(res, handler.handle(err, info(req)));
  };

  return {
    handler,
    requestContext,
    notFound,
    errorHandler,
    correlationId: (req) => ids.get(req),
  };
}

/**
 * Wraps an async route handler so rejections reach the error handler. Required on Express 4;
 * harmless on Express 5.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) => {
    try {
      const out = fn(req, res, next);
      if (
        out !== null &&
        typeof out === 'object' &&
        typeof (out as Promise<unknown>).then === 'function'
      ) {
        (out as Promise<unknown>).then(undefined, next);
      }
    } catch (err) {
      next(err);
    }
  };
}
