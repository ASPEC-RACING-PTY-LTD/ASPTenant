import type { Context, MiddlewareHandler } from 'hono';
import { PROBLEM_JSON, RequestBodyError, toProblemDetails, ValidationError } from '../errors.js';
import {
  normalizeHeaders,
  type RequestSchemas,
  readJsonBody,
  type ValidatedRequest,
  type ValidateRequestOptions,
  validateRequestParts,
} from '../request.js';

export type ValidationVariables<S extends RequestSchemas = RequestSchemas> = {
  validated: ValidatedRequest<S>;
};

export interface HonoValidateOptions extends ValidateRequestOptions {
  /** When true (default), parse JSON body from the request when a body schema is present. */
  parseBody?: boolean;
}

/**
 * Hono middleware that validates body, query, params and/or headers and stores the
 * result in `c.get('validated')` / `c.var.validated`.
 */
export function validateRequest<S extends RequestSchemas>(
  schemas: S,
  options: HonoValidateOptions = {},
): MiddlewareHandler<{ Variables: ValidationVariables<S> }> {
  return async (c, next) => {
    try {
      let body: unknown;
      if (schemas.body !== undefined && options.parseBody !== false) {
        const bodyOpts = options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit };
        body = await readJsonBody(c.req.raw, bodyOpts);
      }
      const validated = await validateRequestParts(
        schemas,
        {
          body,
          query: c.req.query(),
          params: c.req.param(),
          headers: normalizeHeaders(c.req.raw.headers),
        },
        options,
      );
      c.set('validated', validated);
      await next();
    } catch (err) {
      if (err instanceof ValidationError || err instanceof RequestBodyError) {
        const problem = toProblemDetails(err, { instance: c.req.path });
        return new Response(JSON.stringify(problem), {
          status: err.status,
          headers: { 'Content-Type': PROBLEM_JSON },
        });
      }
      throw err;
    }
  };
}

export function getValidated<S extends RequestSchemas>(
  c: Context<{ Variables: ValidationVariables<S> }>,
): ValidatedRequest<S> {
  const value = c.get('validated');
  if (value === undefined) {
    throw new ValidationError([], { message: 'Request was not validated' });
  }
  return value;
}
