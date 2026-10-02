import type { InferOutput, StandardSchemaV1 } from '@aspec/validation';
import type { FieldWhitelist } from './filter-sort.js';
import type { PaginationOptions } from './pagination.js';
import type { ApiResult } from './responses.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

export interface RouteRequestSchemas {
  params?: StandardSchemaV1;
  query?: StandardSchemaV1;
  headers?: StandardSchemaV1;
  body?: StandardSchemaV1;
}

export type InferRequest<R extends RouteRequestSchemas> = {
  [K in keyof R as R[K] extends StandardSchemaV1 ? K : never]: R[K] extends StandardSchemaV1
    ? InferOutput<R[K]>
    : never;
};

export interface RouteResponseSpec {
  description?: string;
  /** Explicit JSON Schema for the response body. */
  jsonSchema?: Record<string, unknown>;
  /** Standard Schema used to derive JSON Schema when jsonSchema is omitted. */
  schema?: StandardSchemaV1;
  headers?: Record<string, { description?: string; schema?: Record<string, unknown> }>;
}

export interface RouteContext<R extends RouteRequestSchemas = RouteRequestSchemas> {
  request: InferRequest<R>;
  /** Raw Fetch Request when available. */
  raw?: Request;
  /** Matched path (no query). */
  path: string;
  method: string;
  /** Correlation / request id when the errors adapter installed one. */
  correlationId?: string;
  /** Resolved API version string. */
  version?: string;
  signal?: AbortSignal;
}

export type RouteHandler<R extends RouteRequestSchemas = RouteRequestSchemas, Out = unknown> = (
  ctx: RouteContext<R>,
) => ApiResult<Out> | Promise<ApiResult<Out>>;

export interface VersionRange {
  /** Inclusive minimum version, for example `1`. */
  min?: string;
  /** Inclusive maximum version. */
  max?: string;
  /** When set, emits Deprecation / Sunset headers (RFC 9745 / RFC 8594). */
  deprecated?: {
    /** RFC 9745 Deprecation header value (HTTP date or boolean). */
    at?: string | true;
    /** RFC 8594 Sunset HTTP date. */
    sunset?: string;
    /** Link rel="deprecation" target. */
    link?: string;
  };
}

export interface DefinedRoute<R extends RouteRequestSchemas = RouteRequestSchemas, Out = unknown> {
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: readonly string[];
  deprecated?: boolean;
  request: R;
  responses: Record<string, RouteResponseSpec>;
  handler: RouteHandler<R, Out>;
  /** Per-route API version constraints. */
  versions?: VersionRange;
  /** Filter/sort whitelist for list endpoints. */
  filterSort?: FieldWhitelist;
  /** Pagination defaults for list endpoints. */
  pagination?: PaginationOptions;
  /** Explicit JSON Schema overrides for request parts. */
  jsonSchema?: {
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    body?: Record<string, unknown>;
  };
  /** Security requirement names from the API's securitySchemes. */
  security?: readonly (string | Record<string, string[]>)[];
}

/** Erased route type for collections (avoids invariant handler issues). */
export type AnyRoute = DefinedRoute<RouteRequestSchemas, unknown> & {
  handler: (ctx: RouteContext) => ApiResult | Promise<ApiResult>;
};

export interface DefineRouteInput<R extends RouteRequestSchemas, Out>
  extends Omit<DefinedRoute<R, Out>, 'request' | 'responses' | 'handler'> {
  request?: R;
  responses?: Record<string, RouteResponseSpec>;
  handler: RouteHandler<R, Out>;
}

/** Defines a typed API route. */
export function defineRoute<R extends RouteRequestSchemas = RouteRequestSchemas, Out = unknown>(
  input: DefineRouteInput<R, Out>,
): DefinedRoute<R, Out> & AnyRoute {
  return {
    ...input,
    request: (input.request ?? {}) as R,
    responses: input.responses ?? { '200': { description: 'OK' } },
  } as DefinedRoute<R, Out> & AnyRoute;
}

export interface ResourceHandlers<_T = unknown, _Id = string> {
  list?: AnyRoute;
  get?: AnyRoute;
  create?: AnyRoute;
  update?: AnyRoute;
  remove?: AnyRoute;
  /** Extra routes attached to the resource. */
  routes?: readonly AnyRoute[];
}

/** Groups CRUD-style routes under a resource name (used for tags and OpenAPI grouping). */
export function defineResource<_T = unknown, _Id = string>(
  name: string,
  handlers: ResourceHandlers<_T, _Id>,
): { name: string; routes: AnyRoute[] } {
  const routes: AnyRoute[] = [];
  for (const key of ['list', 'get', 'create', 'update', 'remove'] as const) {
    const route = handlers[key];
    if (route) {
      routes.push({
        ...route,
        tags: route.tags ?? [name],
      });
    }
  }
  if (handlers.routes) {
    for (const route of handlers.routes) {
      routes.push({ ...route, tags: route.tags ?? [name] });
    }
  }
  return { name, routes };
}
