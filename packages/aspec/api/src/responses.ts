export const PROBLEM_JSON = 'application/problem+json';
export const JSON_CONTENT = 'application/json';

export interface ApiResponseInit {
  headers?: Record<string, string>;
  status?: number;
}

export interface PaginationMeta {
  limit: number;
  offset?: number;
  cursor?: string | undefined;
  nextCursor?: string | undefined;
  prevCursor?: string | undefined;
  total?: number | undefined;
  hasMore: boolean;
}

export interface PaginationLinks {
  self?: string;
  next?: string;
  prev?: string;
  first?: string;
  last?: string;
}

export interface PaginatedBody<T> {
  data: T[];
  meta: PaginationMeta;
  links: PaginationLinks;
}

export interface ApiResult<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T | null;
}

function base(status: number, body: unknown, init: ApiResponseInit = {}): ApiResult {
  const headers: Record<string, string> = { ...init.headers };
  if (body !== null && headers['Content-Type'] === undefined) {
    headers['Content-Type'] = JSON_CONTENT;
  }
  return { status: init.status ?? status, headers, body: body as never };
}

/** 200 OK with a JSON body. */
export function ok<T>(data: T, init?: ApiResponseInit): ApiResult<T> {
  return base(200, data, init) as ApiResult<T>;
}

/** 201 Created with a JSON body. */
export function created<T>(data: T, init?: ApiResponseInit): ApiResult<T> {
  return base(201, data, init) as ApiResult<T>;
}

/** 204 No Content. */
export function noContent(init?: ApiResponseInit): ApiResult<null> {
  const headers = { ...init?.headers };
  return { status: 204, headers, body: null };
}

/** 200 OK paginated envelope `{ data, meta, links }`. */
export function paginated<T>(
  data: readonly T[],
  meta: PaginationMeta,
  links: PaginationLinks = {},
  init?: ApiResponseInit,
): ApiResult<PaginatedBody<T>> {
  const headers = { ...init?.headers };
  const linkHeader = formatLinkHeader(links);
  if (linkHeader !== undefined) headers.Link = linkHeader;
  return base(200, { data: [...data], meta, links }, { ...init, headers }) as ApiResult<
    PaginatedBody<T>
  >;
}

/** Builds an RFC 8288 Link header value from pagination links. */
export function formatLinkHeader(links: PaginationLinks): string | undefined {
  const parts: string[] = [];
  for (const rel of ['self', 'next', 'prev', 'first', 'last'] as const) {
    const href = links[rel];
    if (href !== undefined) parts.push(`<${href}>; rel="${rel}"`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** Converts an ApiResult to a Fetch Response. */
export function toFetchResponse(result: ApiResult): Response {
  if (result.body === null) {
    return new Response(null, { status: result.status, headers: result.headers });
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: result.headers,
  });
}
