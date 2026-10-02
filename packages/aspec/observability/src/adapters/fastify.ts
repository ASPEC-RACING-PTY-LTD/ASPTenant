import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  createObservabilityEndpoints,
  type EndpointOptions,
  type ObservabilityEndpoints,
} from '../endpoints.js';
import {
  type HttpFinishInfo,
  type HttpInstrumentationOptions,
  type HttpRequestInfo,
  parseContentLength,
} from '../http.js';
import { handleEndpoint, headerReader, pathOf, resolveHttpInstrumentation } from './shared.js';

declare module 'fastify' {
  interface FastifyRequest {
    observRequestId?: string;
    observState?: {
      finish(info: HttpFinishInfo): void;
      recordError(error: unknown): void;
      run<T>(fn: () => T): T;
    };
  }
}

function fastifyRoute(request: FastifyRequest): string | undefined {
  const route = request.routeOptions?.url;
  if (typeof route === 'string' && route.length > 0) return route;
  return undefined;
}

function contentLengthHeader(value: string | number | string[] | undefined): number | undefined {
  if (Array.isArray(value)) return parseContentLength(value[0]);
  return parseContentLength(value);
}

export interface FastifyObservabilityOptions extends HttpInstrumentationOptions {
  /** Also register /livez, /readyz, /healthz and /metrics. */
  endpoints?: EndpointOptions | ObservabilityEndpoints;
}

const plugin: FastifyPluginAsync<FastifyObservabilityOptions> = async (app, options) => {
  const { endpoints: endpointOptions, ...httpOptions } = options;
  const http = resolveHttpInstrumentation(httpOptions);
  const endpoints =
    endpointOptions === undefined
      ? undefined
      : typeof (endpointOptions as ObservabilityEndpoints).handle === 'function'
        ? (endpointOptions as ObservabilityEndpoints)
        : createObservabilityEndpoints(endpointOptions as EndpointOptions);

  if (endpoints) {
    app.addHook('onRequest', async (request, reply) => {
      const path = pathOf(request.url);
      const response = await handleEndpoint(
        endpoints,
        request.method,
        path,
        headerReader(request.headers),
      );
      if (!response) return;
      for (const [name, value] of Object.entries(response.headers)) reply.header(name, value);
      return reply.code(response.status).send(response.body === '' ? undefined : response.body);
    });
  }

  app.addHook('onRequest', (request, reply, done) => {
    const hostHeader =
      typeof request.headers.host === 'string' ? request.headers.host.split(':')[0] : undefined;
    const info: HttpRequestInfo = {
      method: request.method,
      path: pathOf(request.url),
      header: headerReader(request.headers),
    };
    const requestSize = parseContentLength(request.headers['content-length']);
    if (requestSize !== undefined) info.requestSize = requestSize;
    if (hostHeader !== undefined) info.host = hostHeader;
    const remote = request.raw.socket?.remoteAddress;
    if (remote !== undefined) info.clientAddress = remote;

    const state = http.start(info);
    request.observRequestId = state.requestId;
    request.observState = state;
    for (const [name, value] of Object.entries(state.responseHeaders)) reply.header(name, value);
    state.run(() => done());
  });

  app.addHook('onResponse', async (request, reply) => {
    const finishInfo: HttpFinishInfo = { statusCode: reply.statusCode };
    const route = fastifyRoute(request);
    if (route !== undefined) finishInfo.route = route;
    const responseSize = contentLengthHeader(
      reply.getHeader('content-length') as string | number | string[] | undefined,
    );
    if (responseSize !== undefined) finishInfo.responseSize = responseSize;
    request.observState?.finish(finishInfo);
  });

  app.addHook('onError', async (request, _reply, error) => {
    request.observState?.recordError(error);
  });
};

(plugin as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true;
(plugin as unknown as Record<symbol, unknown>)[Symbol.for('fastify.display-name')] =
  '@aspec/observability';

/**
 * Fastify plugin: request correlation, HTTP metrics and optional health/metrics endpoints.
 * Register with `app.register(fastifyObservability, options)`.
 */
export const fastifyObservability: FastifyPluginAsync<FastifyObservabilityOptions> = plugin;
