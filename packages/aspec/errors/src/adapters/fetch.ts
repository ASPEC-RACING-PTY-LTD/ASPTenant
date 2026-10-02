import { createErrorHandler, type ErrorHandler, type ErrorHandlerOptions } from '../handler.js';

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface WithErrorHandlingOptions extends ErrorHandlerOptions {
  /** Existing error handler to reuse instead of creating one from the options. */
  handler?: ErrorHandler;
}

function withHeader(response: Response, name: string, value: string): Response {
  try {
    response.headers.set(name, value);
    return response;
  } catch {
    // Responses from fetch() have immutable headers: copy into a new Response.
    const copy = new Response(response.body, response);
    copy.headers.set(name, value);
    return copy;
  }
}

/**
 * Wraps a Web Fetch API handler `(request) => Response` with correlation IDs and safe error
 * responses. Works in any runtime that exposes the Fetch API.
 */
export function withErrorHandling(
  fetchHandler: FetchHandler,
  options: WithErrorHandlingOptions = {},
): (request: Request) => Promise<Response> {
  const { handler: provided, ...rest } = options;
  const handler = provided ?? createErrorHandler(rest);
  const header = handler.correlation.header;
  return async (request) => {
    const id = handler.correlation.resolve(request.headers.get(header));
    const url = new URL(request.url);
    return handler.correlation.run(id, async () => {
      try {
        const response = await fetchHandler(request);
        return withHeader(response, header, id);
      } catch (err) {
        return handler.toResponse(err, {
          method: request.method,
          path: url.pathname,
          correlationId: id,
        });
      }
    });
  };
}

/** A Fetch handler that answers every request with a 404 problem response. */
export function fetchNotFound(
  options: WithErrorHandlingOptions = {},
): (request: Request) => Response {
  const { handler: provided, ...rest } = options;
  const handler = provided ?? createErrorHandler(rest);
  return (request) => {
    const r = handler.notFound({
      method: request.method,
      path: new URL(request.url).pathname,
      correlationId: handler.correlation.resolve(request.headers.get(handler.correlation.header)),
    });
    return new Response(handler.serialize(r), { status: r.status, headers: r.headers });
  };
}
