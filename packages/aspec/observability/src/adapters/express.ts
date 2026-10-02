import type { IncomingMessage, ServerResponse } from 'node:http';
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
import type { CaptureError } from '../instrument.js';
import {
  applyEndpointResponse,
  handleEndpoint,
  headerReader,
  pathOf,
  resolveHttpInstrumentation,
} from './shared.js';

/** Structural Express request (works with Express 4 and 5). */
export interface ExpressObservabilityRequest extends IncomingMessage {
  originalUrl?: string;
  baseUrl?: string;
  path?: string;
  route?: { path?: string };
  observRequestId?: string;
}

export type ExpressMiddleware = (
  req: ExpressObservabilityRequest,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

export type ExpressErrorMiddleware = (
  err: unknown,
  req: ExpressObservabilityRequest,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

function expressRoute(req: ExpressObservabilityRequest): string | undefined {
  const routePath = req.route?.path;
  if (typeof routePath !== 'string' || routePath.length === 0) return undefined;
  const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  if (routePath === '/') return base || '/';
  return `${base}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
}

function contentLengthHeader(value: string | number | string[] | undefined): number | undefined {
  if (Array.isArray(value)) return parseContentLength(value[0]);
  return parseContentLength(value);
}

/**
 * Express 4 and 5 middleware: request correlation, HTTP metrics, access logs and optional
 * tracing. Mount early. The request ID is available as `req.observRequestId`.
 */
export function httpInstrumentation(
  options: HttpInstrumentationOptions | HttpInstrumentation = {},
): ExpressMiddleware {
  const http = resolveHttpInstrumentation(options);
  return (req, res, next) => {
    const hostHeader =
      typeof req.headers.host === 'string' ? req.headers.host.split(':')[0] : undefined;
    const info: HttpRequestInfo = {
      method: req.method ?? 'GET',
      path: pathOf(req.originalUrl ?? req.url),
      header: headerReader(req.headers),
    };
    const requestSize = parseContentLength(req.headers['content-length']);
    if (requestSize !== undefined) info.requestSize = requestSize;
    if (hostHeader !== undefined) info.host = hostHeader;
    if (req.socket?.remoteAddress !== undefined) info.clientAddress = req.socket.remoteAddress;

    const state = http.start(info);
    req.observRequestId = state.requestId;
    for (const [name, value] of Object.entries(state.responseHeaders)) {
      if (!res.headersSent) res.setHeader(name, value);
    }
    let finished = false;
    const finish = (aborted: boolean): void => {
      if (finished) return;
      finished = true;
      const finishInfo: HttpFinishInfo = { statusCode: res.statusCode, aborted };
      const route = expressRoute(req);
      if (route !== undefined) finishInfo.route = route;
      const responseSize = contentLengthHeader(
        res.getHeader('content-length') as string | number | string[] | undefined,
      );
      if (responseSize !== undefined) finishInfo.responseSize = responseSize;
      state.finish(finishInfo);
    };
    res.on('finish', () => finish(false));
    res.on('close', () => {
      if (!res.writableEnded) finish(true);
    });
    state.run(() => next());
  };
}

/**
 * Express error middleware that records the error on the active request and forwards it.
 * Mount after routes: `app.use(errorHandler(captureError))`.
 */
export function errorHandler(captureError?: CaptureError): ExpressErrorMiddleware {
  return (err, req, _res, next) => {
    captureError?.(err, { source: 'http', path: pathOf(req.originalUrl ?? req.url) });
    next(err);
  };
}

/**
 * Serves /livez, /readyz, /healthz and /metrics. Mount before or after instrumentation;
 * ignored paths can exclude these from metrics.
 */
export function observabilityEndpoints(
  options: EndpointOptions | ObservabilityEndpoints,
): ExpressMiddleware {
  const endpoints =
    typeof (options as ObservabilityEndpoints).handle === 'function'
      ? (options as ObservabilityEndpoints)
      : createObservabilityEndpoints(options as EndpointOptions);
  return (req, res, next) => {
    const path = pathOf(req.originalUrl ?? req.url);
    handleEndpoint(endpoints, req.method ?? 'GET', path, headerReader(req.headers))
      .then((response) => {
        if (!response) {
          next();
          return;
        }
        applyEndpointResponse(res, response);
      })
      .catch(next);
  };
}
