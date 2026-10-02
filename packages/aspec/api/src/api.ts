import {
  createErrorHandler,
  type ErrorHandler,
  type ErrorHandlerOptions,
  NotFoundError,
} from '@aspec/errors';
import { type RequestSchemas, ValidationError, validateRequestParts } from '@aspec/validation';
import {
  type BuildOpenApiOptions,
  buildOpenApi,
  type OpenApiDocument,
  renderDocsHtml,
} from './openapi.js';
import type { ApiResult } from './responses.js';
import { PROBLEM_JSON, toFetchResponse } from './responses.js';
import type { AnyRoute, HttpMethod, RouteContext } from './route.js';
import {
  deprecationHeaders,
  resolveVersion,
  routeMatchesVersion,
  type VersioningOptions,
} from './versioning.js';

export interface CreateApiOptions {
  info: BuildOpenApiOptions['info'];
  servers?: BuildOpenApiOptions['servers'];
  routes: readonly AnyRoute[];
  versioning?: VersioningOptions;
  errors?: ErrorHandlerOptions | ErrorHandler;
  securitySchemes?: BuildOpenApiOptions['securitySchemes'];
  tags?: BuildOpenApiOptions['tags'];
  /** Base path prefix applied before versioning, for example `/api`. */
  basePath?: string;
}

export interface MatchedRoute {
  route: AnyRoute;
  params: Record<string, string>;
}

export interface HandleRequestOptions {
  /** Override path (default: URL pathname). */
  path?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  correlationId?: string;
  signal?: AbortSignal;
}

export interface Api {
  readonly routes: readonly AnyRoute[];
  readonly errors: ErrorHandler;
  readonly versioning: VersioningOptions | undefined;
  openapi(): OpenApiDocument;
  docsHtml(): string;
  match(method: string, path: string): MatchedRoute | undefined;
  handle(request: Request, options?: HandleRequestOptions): Promise<Response>;
  execute(route: AnyRoute, ctx: RouteContext): Promise<ApiResult>;
}

function isHandler(v: ErrorHandlerOptions | ErrorHandler): v is ErrorHandler {
  return typeof (v as ErrorHandler).handle === 'function' && 'correlation' in v;
}

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path || '/';
}

function patternToRegex(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      const braced = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(seg);
      if (braced) {
        keys.push(braced[1]!);
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

/** Creates an API from route definitions with OpenAPI, validation and error handling. */
export function createApi(options: CreateApiOptions): Api {
  const errors = isHandler(options.errors ?? {})
    ? (options.errors as ErrorHandler)
    : createErrorHandler(options.errors ?? {});
  const compiled = options.routes.map((route) => ({
    route,
    ...patternToRegex(route.path),
  }));

  const openapi = (): OpenApiDocument => {
    const opts: BuildOpenApiOptions = {
      info: options.info,
      routes: options.routes,
    };
    if (options.servers !== undefined) opts.servers = options.servers;
    if (options.securitySchemes !== undefined) opts.securitySchemes = options.securitySchemes;
    if (options.tags !== undefined) opts.tags = options.tags;
    return buildOpenApi(opts);
  };

  const match = (method: string, path: string): MatchedRoute | undefined => {
    const m = method.toLowerCase() as HttpMethod;
    const p = normalizePath(path);
    for (const c of compiled) {
      if (c.route.method !== m) continue;
      const found = c.regex.exec(p);
      if (!found) continue;
      const params: Record<string, string> = {};
      c.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(found[i + 1] ?? '');
      });
      return { route: c.route, params };
    }
    return undefined;
  };

  const execute = async (route: AnyRoute, ctx: RouteContext): Promise<ApiResult> => {
    return route.handler(ctx);
  };

  const handle = async (
    request: Request,
    handleOptions: HandleRequestOptions = {},
  ): Promise<Response> => {
    const url = new URL(request.url);
    let path = normalizePath(handleOptions.path ?? url.pathname);
    const base = options.basePath ? normalizePath(options.basePath) : '';
    if (base && (path === base || path.startsWith(`${base}/`))) {
      path = path === base ? '/' : path.slice(base.length) || '/';
    }

    let version: string | undefined;
    let versionHeaders: Record<string, string> = {};
    if (options.versioning) {
      try {
        const resolved = resolveVersion(path, request.headers, options.versioning);
        version = resolved.version;
        path = resolved.path;
        versionHeaders = resolved.headers;
      } catch (err) {
        return errors.toResponse(err, {
          method: request.method,
          path,
          correlationId: handleOptions.correlationId,
        });
      }
    }

    // Docs and OpenAPI helpers
    if (request.method === 'GET' && path === '/openapi.json') {
      return Response.json(openapi(), {
        headers: { ...versionHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (request.method === 'GET' && (path === '/docs' || path === '/docs/')) {
      return new Response(renderDocsHtml(openapi()), {
        headers: { ...versionHeaders, 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const matched = match(request.method, path);
    if (!matched) {
      return errors.toResponse(new NotFoundError('Route not found'), {
        method: request.method,
        path,
        correlationId: handleOptions.correlationId,
      });
    }

    const { route, params: pathParams } = matched;
    if (
      options.versioning &&
      version &&
      !routeMatchesVersion(version, route.versions, options.versioning.versions)
    ) {
      return errors.toResponse(new NotFoundError('Route not available in this API version'), {
        method: request.method,
        path,
        correlationId: handleOptions.correlationId,
      });
    }

    try {
      let body = handleOptions.body;
      if (
        body === undefined &&
        route.request.body &&
        request.method !== 'GET' &&
        request.method !== 'HEAD'
      ) {
        const text = await request.text();
        body = text === '' ? undefined : JSON.parse(text);
      }
      const query = handleOptions.query ?? Object.fromEntries(url.searchParams);
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });

      const schemas = route.request as RequestSchemas;
      const validated = await validateRequestParts(schemas, {
        body,
        query,
        params: handleOptions.params ?? pathParams,
        headers,
      });

      const dep = deprecationHeaders(route.versions);
      const ctx: RouteContext = {
        request: validated,
        raw: request,
        path,
        method: request.method,
        signal: handleOptions.signal ?? request.signal,
      };
      if (handleOptions.correlationId !== undefined)
        ctx.correlationId = handleOptions.correlationId;
      if (version !== undefined) ctx.version = version;

      const result = await execute(route, ctx);
      const headersOut = { ...versionHeaders, ...dep, ...result.headers };
      if (result.body === null) {
        return new Response(null, { status: result.status, headers: headersOut });
      }
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: headersOut,
      });
    } catch (err) {
      if (err instanceof SyntaxError) {
        return errors.toResponse(err, {
          method: request.method,
          path,
          correlationId: handleOptions.correlationId,
        });
      }
      if (err instanceof ValidationError) {
        const problem = {
          type: 'about:blank',
          title: 'Bad Request',
          status: err.status,
          detail: err.message,
          code: err.code,
          errors: err.issues,
        };
        return new Response(JSON.stringify(problem), {
          status: err.status,
          headers: { ...versionHeaders, 'Content-Type': PROBLEM_JSON },
        });
      }
      return errors.toResponse(err, {
        method: request.method,
        path,
        correlationId: handleOptions.correlationId,
      });
    }
  };

  return {
    routes: options.routes,
    errors,
    versioning: options.versioning,
    openapi,
    docsHtml: () => renderDocsHtml(openapi()),
    match,
    handle,
    execute,
  };
}

export { toFetchResponse };
