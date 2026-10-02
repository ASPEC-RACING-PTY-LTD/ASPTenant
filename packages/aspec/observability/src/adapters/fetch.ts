import {
  createObservabilityEndpoints,
  type EndpointOptions,
  type ObservabilityEndpoints,
} from '../endpoints.js';
import {
  createHttpInstrumentation,
  type HttpFinishInfo,
  type HttpInstrumentation,
  type HttpInstrumentationOptions,
  type HttpRequestInfo,
  type HttpRequestState,
  parseContentLength,
} from '../http.js';
import { handleEndpoint, resolveHttpInstrumentation } from './shared.js';

export interface FetchObservabilityOptions extends HttpInstrumentationOptions {
  endpoints?: EndpointOptions | ObservabilityEndpoints;
  /**
   * Returns the route template for metrics (for example `/users/:id`). Without it, the path
   * is used only when getRoute returns a value; otherwise the unmatched label applies.
   */
  getRoute?: (request: Request, response: Response) => string | undefined;
}

export interface FetchObservability {
  readonly http: HttpInstrumentation;
  /** Starts instrumentation for a request. Call `finish` when the response is ready. */
  start(request: Request): HttpRequestState;
  /** Handles health/metrics endpoints when configured; otherwise undefined. */
  tryEndpoints(request: Request): Promise<Response | undefined>;
  /** Applies response headers (request ID) to a Response. */
  applyHeaders(response: Response, state: HttpRequestState): Response;
}

export function createFetchObservability(
  options: FetchObservabilityOptions = {},
): FetchObservability {
  const { endpoints: endpointOptions, getRoute: _getRoute, ...httpOptions } = options;
  const http = resolveHttpInstrumentation(httpOptions);
  const endpoints =
    endpointOptions === undefined
      ? undefined
      : typeof (endpointOptions as ObservabilityEndpoints).handle === 'function'
        ? (endpointOptions as ObservabilityEndpoints)
        : createObservabilityEndpoints(endpointOptions as EndpointOptions);

  return {
    http,
    start(request) {
      const url = new URL(request.url);
      const info: HttpRequestInfo = {
        method: request.method,
        path: url.pathname,
        header: (name) => request.headers.get(name) ?? undefined,
        host: url.hostname,
        scheme: url.protocol.replace(':', ''),
      };
      const requestSize = parseContentLength(request.headers.get('content-length'));
      if (requestSize !== undefined) info.requestSize = requestSize;
      if (url.port) info.port = Number(url.port);
      return http.start(info);
    },
    async tryEndpoints(request) {
      if (!endpoints) return undefined;
      const url = new URL(request.url);
      const response = await handleEndpoint(
        endpoints,
        request.method,
        url.pathname,
        (name) => request.headers.get(name) ?? undefined,
      );
      if (!response) return undefined;
      return new Response(response.body === '' ? null : response.body, {
        status: response.status,
        headers: response.headers,
      });
    },
    applyHeaders(response, state) {
      const entries = Object.entries(state.responseHeaders);
      if (entries.length === 0) return response;
      const copy = new Response(response.body, response);
      for (const [name, value] of entries) copy.headers.set(name, value);
      return copy;
    },
  };
}

/** Wraps a Fetch handler with request correlation, metrics and optional endpoints. */
export function withObservability<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Response | Promise<Response>,
  options: FetchObservabilityOptions = {},
): (request: Request, ...args: Args) => Promise<Response> {
  const obs = createFetchObservability(options);
  return async (request, ...args) => {
    const endpoint = await obs.tryEndpoints(request);
    if (endpoint) return endpoint;
    const state = obs.start(request);
    try {
      const response = await state.run(() => handler(request, ...args));
      const out = obs.applyHeaders(await response, state);
      const finishInfo: HttpFinishInfo = { statusCode: out.status };
      const route = options.getRoute?.(request, out);
      if (route !== undefined) finishInfo.route = route;
      const responseSize = parseContentLength(out.headers.get('content-length'));
      if (responseSize !== undefined) finishInfo.responseSize = responseSize;
      state.finish(finishInfo);
      return out;
    } catch (error) {
      state.recordError(error);
      const finishInfo: HttpFinishInfo = { statusCode: 500, error };
      const route = options.getRoute?.(request, new Response(null, { status: 500 }));
      if (route !== undefined) finishInfo.route = route;
      state.finish(finishInfo);
      throw error;
    }
  };
}

export { createHttpInstrumentation };
