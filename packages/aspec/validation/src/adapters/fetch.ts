import { PROBLEM_JSON, RequestBodyError, toProblemDetails, ValidationError } from '../errors.js';
import {
  normalizeHeaders,
  type RequestSchemas,
  readJsonBody,
  type ValidatedRequest,
  type ValidateRequestOptions,
  validateRequestParts,
} from '../request.js';

export interface FetchValidateOptions extends ValidateRequestOptions {
  /** When true (default), parse JSON body when a body schema is present. */
  parseBody?: boolean;
  /** Override path used as problem `instance`. Default: URL pathname. */
  instance?: string;
}

export interface ValidatedFetchRequest<S extends RequestSchemas> {
  request: Request;
  url: URL;
  validated: ValidatedRequest<S>;
}

function problemResponse(err: ValidationError | RequestBodyError, instance: string): Response {
  return new Response(JSON.stringify(toProblemDetails(err, { instance })), {
    status: err.status,
    headers: { 'Content-Type': PROBLEM_JSON },
  });
}

/**
 * Validates a Fetch API request. Returns validated parts, or a problem+json Response.
 */
export async function validateFetchRequest<S extends RequestSchemas>(
  request: Request,
  schemas: S,
  options: FetchValidateOptions = {},
): Promise<ValidatedFetchRequest<S> | Response> {
  const url = new URL(request.url);
  const instance = options.instance ?? url.pathname;
  try {
    let body: unknown;
    if (schemas.body !== undefined && options.parseBody !== false) {
      const bodyOpts = options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit };
      body = await readJsonBody(request, bodyOpts);
    }
    const query = Object.fromEntries(url.searchParams);
    // Path params are not available on a bare Request; consumers with a router should use
    // validateFetchParts and pass params explicitly.
    const validated = await validateRequestParts(
      schemas,
      {
        body,
        query,
        headers: normalizeHeaders(request.headers),
      },
      options,
    );
    return { request, url, validated };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof RequestBodyError) {
      return problemResponse(err, instance);
    }
    throw err;
  }
}

/**
 * Wraps a Fetch handler with request validation. On validation failure returns problem+json.
 */
export function withValidation<S extends RequestSchemas>(
  schemas: S,
  handler: (ctx: ValidatedFetchRequest<S>) => Response | Promise<Response>,
  options: FetchValidateOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const result = await validateFetchRequest(request, schemas, options);
    if (result instanceof Response) return result;
    return handler(result);
  };
}

/** Validates router-provided params together with a Fetch Request. */
export async function validateFetchParts<S extends RequestSchemas>(
  request: Request,
  schemas: S,
  parts: { params?: Record<string, string>; query?: Record<string, string> },
  options: FetchValidateOptions = {},
): Promise<ValidatedRequest<S>> {
  const url = new URL(request.url);
  let body: unknown;
  if (schemas.body !== undefined && options.parseBody !== false) {
    const bodyOpts = options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit };
    body = await readJsonBody(request, bodyOpts);
  }
  return validateRequestParts(
    schemas,
    {
      body,
      query: parts.query ?? Object.fromEntries(url.searchParams),
      params: parts.params,
      headers: normalizeHeaders(request.headers),
    },
    options,
  );
}
