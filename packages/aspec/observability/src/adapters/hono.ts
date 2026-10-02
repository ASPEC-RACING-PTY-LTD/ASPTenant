import type { Context, MiddlewareHandler } from 'hono';
import {
  createObservabilityEndpoints,
  type EndpointOptions,
  type ObservabilityEndpoints,
} from '../endpoints.js';
import {
  type HttpFinishInfo,
  type HttpInstrumentation,
  type HttpInstrumentationOptions,
  type HttpRequestInfo,
  parseContentLength,
} from '../http.js';
import { handleEndpoint, pathOf, resolveHttpInstrumentation } from './shared.js';

export interface ObservabilityVariables {
  observRequestId: string;
}

export interface HonoObservabilityOptions extends HttpInstrumentationOptions {
  endpoints?: EndpointOptions | ObservabilityEndpoints;
}

function honoRoute(c: Context): string | undefined {
  const path = c.req.routePath;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

/**
 * Hono middleware: request correlation, HTTP metrics and optional health/metrics endpoints.
 * The request ID is available as `c.get('observRequestId')`.
 */
export function observability(
  options: HonoObservabilityOptions | HttpInstrumentation = {},
): MiddlewareHandler<{ Variables: ObservabilityVariables }> {
  const endpointOptions =
    typeof options === 'object' && options !== null && 'endpoints' in options
      ? (options as HonoObservabilityOptions).endpoints
      : undefined;
  const http = resolveHttpInstrumentation(
    endpointOptions !== undefined
      ? (() => {
          const { endpoints: _e, ...rest } = options as HonoObservabilityOptions;
          return rest;
        })()
      : (options as HttpInstrumentationOptions | HttpInstrumentation),
  );
  const endpoints =
    endpointOptions === undefined
      ? undefined
      : typeof (endpointOptions as ObservabilityEndpoints).handle === 'function'
        ? (endpointOptions as ObservabilityEndpoints)
        : createObservabilityEndpoints(endpointOptions as EndpointOptions);

  return async (c, next) => {
    const path = pathOf(c.req.path);
    if (endpoints) {
      const response = await handleEndpoint(endpoints, c.req.method, path, (name) =>
        c.req.header(name),
      );
      if (response) {
        return new Response(response.body === '' ? null : response.body, {
          status: response.status,
          headers: response.headers,
        });
      }
    }

    const info: HttpRequestInfo = {
      method: c.req.method,
      path,
      header: (name) => c.req.header(name),
    };
    const requestSize = parseContentLength(c.req.header('content-length'));
    if (requestSize !== undefined) info.requestSize = requestSize;
    const host = c.req.header('host')?.split(':')[0];
    if (host !== undefined) info.host = host;

    const state = http.start(info);
    c.set('observRequestId', state.requestId);
    for (const [name, value] of Object.entries(state.responseHeaders)) c.header(name, value);

    try {
      await state.run(() => next());
      const finishInfo: HttpFinishInfo = { statusCode: c.res.status };
      const route = honoRoute(c);
      if (route !== undefined) finishInfo.route = route;
      const responseSize = parseContentLength(c.res.headers.get('content-length'));
      if (responseSize !== undefined) finishInfo.responseSize = responseSize;
      state.finish(finishInfo);
    } catch (error) {
      state.recordError(error);
      const finishInfo: HttpFinishInfo = { statusCode: c.res.status || 500, error };
      const route = honoRoute(c);
      if (route !== undefined) finishInfo.route = route;
      state.finish(finishInfo);
      throw error;
    }
    return undefined;
  };
}
