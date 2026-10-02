import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { PROBLEM_JSON, RequestBodyError, toProblemDetails, ValidationError } from '../errors.js';
import {
  normalizeHeaders,
  type RequestSchemas,
  type ValidatedRequest,
  type ValidateRequestOptions,
  validateRequestParts,
} from '../request.js';

export type ValidatedProperty = 'validated';

declare global {
  // Augment Express Request with typed validated parts when consumers declare the schemas.
  namespace Express {
    interface Request {
      validated?: ValidatedRequest<RequestSchemas>;
    }
  }
}

export interface ExpressValidateOptions extends ValidateRequestOptions {
  /** Property on `req` that receives validated values. Default `validated`. */
  property?: ValidatedProperty | string;
}

function pathOf(req: Request): string {
  const url = req.originalUrl || req.url || '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function sendProblem(
  res: Response,
  err: ValidationError | RequestBodyError,
  instance: string,
): void {
  const problem = toProblemDetails(err, { instance });
  res.status(err.status);
  res.setHeader('Content-Type', PROBLEM_JSON);
  res.end(JSON.stringify(problem));
}

/**
 * Express 4 and 5 middleware that validates body, query, params and/or headers.
 * On success, attaches typed values to `req.validated` (or a custom property).
 * On failure, responds with RFC 9457 `application/problem+json` (400 by default).
 */
export function validateRequest<S extends RequestSchemas>(
  schemas: S,
  options: ExpressValidateOptions = {},
): RequestHandler {
  const property = options.property ?? 'validated';
  return (req: Request, res: Response, next: NextFunction) => {
    const run = async () => {
      const validated = await validateRequestParts(
        schemas,
        {
          body: req.body,
          query: req.query,
          params: req.params,
          headers: normalizeHeaders(req.headers as Record<string, string | string[] | undefined>),
        },
        options,
      );
      (req as Request & Record<string, unknown>)[property] = validated;
      next();
    };
    run().catch((err: unknown) => {
      if (err instanceof ValidationError || err instanceof RequestBodyError) {
        sendProblem(res, err, pathOf(req));
        return;
      }
      next(err);
    });
  };
}

/** Typed accessor for validated request parts. */
export function getValidated<S extends RequestSchemas>(
  req: Request,
  property: string = 'validated',
): ValidatedRequest<S> {
  const value = (req as Request & Record<string, unknown>)[property];
  if (value === undefined) {
    throw new ValidationError([], { message: 'Request was not validated' });
  }
  return value as ValidatedRequest<S>;
}
