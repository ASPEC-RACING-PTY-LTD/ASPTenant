import type {
  Context,
  ErrorHandler as HonoErrorHandler,
  MiddlewareHandler,
  NotFoundHandler,
} from 'hono';
import {
  createErrorHandler,
  type ErrorHandler,
  type ErrorHandlerOptions,
  type ErrorRequestInfo,
  type ErrorResponse,
} from '../handler.js';

export interface HonoErrorHandling {
  readonly handler: ErrorHandler;
  /** Correlation middleware: `app.use('*', errors.middleware)`. */
  readonly middleware: MiddlewareHandler;
  /** `app.onError(errors.onError)`. */
  readonly onError: HonoErrorHandler;
  /** `app.notFound(errors.notFound)`. */
  readonly notFound: NotFoundHandler;
  /** Correlation ID assigned to the request of a context. */
  correlationId(c: Context): string | undefined;
}

function isHandler(v: ErrorHandlerOptions | ErrorHandler): v is ErrorHandler {
  return typeof (v as ErrorHandler).handle === 'function' && 'correlation' in v;
}

/** Hono 4 error handling: correlation middleware, `onError` and `notFound` handlers. */
export function createHonoErrorHandling(
  options: ErrorHandlerOptions | ErrorHandler = {},
): HonoErrorHandling {
  const handler = isHandler(options) ? options : createErrorHandler(options);
  const header = handler.correlation.header;
  const ids = new WeakMap<Request, string>();

  const info = (c: Context): ErrorRequestInfo => ({
    method: c.req.method,
    path: c.req.path,
    correlationId: ids.get(c.req.raw),
  });
  const toResponse = (r: ErrorResponse): Response =>
    new Response(handler.serialize(r), { status: r.status, headers: r.headers });

  const middleware: MiddlewareHandler = async (c, next) => {
    const id = handler.correlation.resolve(c.req.header(header));
    ids.set(c.req.raw, id);
    await handler.correlation.run(id, async () => {
      await next();
    });
    c.header(header, id);
  };

  return {
    handler,
    middleware,
    onError: (err, c) => toResponse(handler.handle(err, info(c))),
    notFound: (c) => toResponse(handler.notFound(info(c))),
    correlationId: (c) => ids.get(c.req.raw),
  };
}
