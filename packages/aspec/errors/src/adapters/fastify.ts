import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createErrorHandler,
  type ErrorHandler,
  type ErrorHandlerOptions,
  type ErrorRequestInfo,
  type ErrorResponse,
} from '../handler.js';

export interface FastifyErrorHandlingOptions extends ErrorHandlerOptions {
  /** Existing error handler to reuse instead of creating one from the options. */
  handler?: ErrorHandler;
  /** Register the not-found handler. Default true. */
  notFound?: boolean;
}

export interface FastifyErrorHandling {
  readonly handler: ErrorHandler;
  /** Correlation ID assigned to a request. */
  correlationId(request: FastifyRequest): string | undefined;
}

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Registers the correlation hook, `setErrorHandler` and `setNotFoundHandler` on a Fastify
 * instance. Call it on the root instance (or inside an encapsulated plugin to scope it).
 */
export function registerErrorHandling(
  app: FastifyInstance,
  options: FastifyErrorHandlingOptions = {},
): FastifyErrorHandling {
  const { handler: provided, notFound = true, ...rest } = options;
  const handler = provided ?? createErrorHandler(rest);
  const header = handler.correlation.header;
  const ids = new WeakMap<FastifyRequest, string>();

  const info = (request: FastifyRequest): ErrorRequestInfo => ({
    method: request.method,
    path: pathOf(request.url),
    correlationId: ids.get(request),
  });
  const send = (reply: FastifyReply, r: ErrorResponse): FastifyReply => {
    reply.code(r.status);
    for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    return reply.send(handler.serialize(r));
  };

  app.addHook('onRequest', (request, reply, done) => {
    const id = handler.correlation.resolve(request.headers[header]);
    ids.set(request, id);
    reply.header(header, id);
    handler.correlation.run(id, () => done());
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    return send(reply, handler.handle(error, info(request)));
  });

  if (notFound) {
    app.setNotFoundHandler((request, reply) => {
      return send(reply, handler.notFound(info(request)));
    });
  }

  return { handler, correlationId: (request) => ids.get(request) };
}

/**
 * Fastify plugin form of `registerErrorHandling`. It skips encapsulation (like fastify-plugin)
 * so the handlers apply to the instance that registers it:
 * `await app.register(fastifyErrorHandling, { typeBaseUri: '...' })`.
 */
export async function fastifyErrorHandling(
  app: FastifyInstance,
  options: FastifyErrorHandlingOptions,
): Promise<void> {
  registerErrorHandling(app, options);
}
Object.defineProperty(fastifyErrorHandling, Symbol.for('skip-override'), { value: true });
Object.defineProperty(fastifyErrorHandling, Symbol.for('fastify.display-name'), {
  value: '@aspec/errors',
});
