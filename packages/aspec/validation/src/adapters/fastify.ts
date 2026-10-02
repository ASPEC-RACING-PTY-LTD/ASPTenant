import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import { PROBLEM_JSON, RequestBodyError, toProblemDetails, ValidationError } from '../errors.js';
import {
  normalizeHeaders,
  type RequestSchemas,
  type ValidatedRequest,
  type ValidateRequestOptions,
  validateRequestParts,
} from '../request.js';

export interface FastifyValidateOptions extends ValidateRequestOptions {
  /** Decorate request with this property. Default `validated`. */
  property?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    validated?: ValidatedRequest<RequestSchemas>;
  }
}

function pathOf(req: FastifyRequest): string {
  return req.url.split('?')[0] ?? '/';
}

function sendProblem(
  reply: FastifyReply,
  err: ValidationError | RequestBodyError,
  instance: string,
): void {
  void reply
    .status(err.status)
    .header('Content-Type', PROBLEM_JSON)
    .send(toProblemDetails(err, { instance }));
}

/**
 * Returns a Fastify `preHandler` that validates selected request parts and attaches
 * them to `request.validated`.
 */
export function validateRequest<S extends RequestSchemas>(
  schemas: S,
  options: FastifyValidateOptions = {},
): preHandlerHookHandler {
  const property = options.property ?? 'validated';
  return async (request, reply) => {
    try {
      const validated = await validateRequestParts(
        schemas,
        {
          body: request.body,
          query: request.query,
          params: request.params,
          headers: normalizeHeaders(
            request.headers as Record<string, string | string[] | undefined>,
          ),
        },
        options,
      );
      (request as FastifyRequest & Record<string, unknown>)[property] = validated;
    } catch (err) {
      if (err instanceof ValidationError || err instanceof RequestBodyError) {
        sendProblem(reply, err, pathOf(request));
        return;
      }
      throw err;
    }
  };
}

/**
 * Fastify plugin that disables Fastify's built-in schema validation and installs a
 * consistent error serializer for ValidationError / RequestBodyError.
 */
export const validationPlugin: FastifyPluginAsync<FastifyValidateOptions> = async (
  app: FastifyInstance,
  _options,
) => {
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ValidationError || err instanceof RequestBodyError) {
      sendProblem(reply, err, pathOf(request));
      return;
    }
    throw err;
  });
};

export function getValidated<S extends RequestSchemas>(
  request: FastifyRequest,
  property: string = 'validated',
): ValidatedRequest<S> {
  const value = (request as FastifyRequest & Record<string, unknown>)[property];
  if (value === undefined) {
    throw new ValidationError([], { message: 'Request was not validated' });
  }
  return value as ValidatedRequest<S>;
}
