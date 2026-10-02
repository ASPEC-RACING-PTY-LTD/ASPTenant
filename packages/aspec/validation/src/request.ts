import { RequestBodyError, ValidationError, type ValidationStatus } from './errors.js';
import type { MessageCustomizer, PathKey, ValidationIssue } from './issues.js';
import type { InferOutput, StandardSchemaV1 } from './standard-schema.js';
import { type ValidateOptions, validate } from './validate.js';

/** Parts of an HTTP request that can be validated. */
export type RequestPart = 'body' | 'query' | 'params' | 'headers';

export interface RequestSchemas {
  body?: StandardSchemaV1;
  query?: StandardSchemaV1;
  params?: StandardSchemaV1;
  headers?: StandardSchemaV1;
}

export interface ValidateRequestOptions extends ValidateOptions {
  /** Status for ValidationError. Default 400. */
  status?: ValidationStatus;
  /** Maximum JSON body size in bytes (Fetch adapter). Default 1 MiB. */
  bodyLimit?: number;
}

/** Typed validated request parts. Only keys present in the schema map are set. */
export type ValidatedRequest<S extends RequestSchemas> = {
  [K in keyof S as S[K] extends StandardSchemaV1 ? K : never]: S[K] extends StandardSchemaV1
    ? InferOutput<S[K]>
    : never;
};

export interface RawRequestParts {
  body?: unknown;
  query?: unknown;
  params?: unknown;
  headers?: unknown;
}

/**
 * Validates selected request parts. Collects issues from every part (with path prefixes)
 * and throws a single ValidationError when any fail.
 */
export async function validateRequestParts<S extends RequestSchemas>(
  schemas: S,
  parts: RawRequestParts,
  options: ValidateRequestOptions = {},
): Promise<ValidatedRequest<S>> {
  const issues: ValidationIssue[] = [];
  const out: Record<string, unknown> = {};
  const order: RequestPart[] = ['params', 'query', 'headers', 'body'];
  for (const part of order) {
    const schema = schemas[part];
    if (schema === undefined) continue;
    const opts: ValidateOptions = { pathPrefix: [part] };
    if (options.messages !== undefined) opts.messages = options.messages;
    if (options.libraryOptions !== undefined) opts.libraryOptions = options.libraryOptions;
    const result = await validate(schema, parts[part], opts);
    if (result.success) out[part] = result.value;
    else issues.push(...result.issues);
  }
  if (issues.length > 0) {
    throw new ValidationError(issues, {
      status: options.status ?? 400,
      message: 'Validation failed',
    });
  }
  return out as ValidatedRequest<S>;
}

/** Reads and parses a JSON request body for Fetch-style handlers. */
export async function readJsonBody(
  request: Request,
  options: { bodyLimit?: number; messages?: MessageCustomizer } = {},
): Promise<unknown> {
  const limit = options.bodyLimit ?? 1_048_576;
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType !== '' && !/\bapplication\/json\b/i.test(contentType)) {
    throw new RequestBodyError(
      'VALIDATION_UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be application/json',
      { contentType },
    );
  }
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > limit) {
      throw new RequestBodyError(
        'VALIDATION_BODY_TOO_LARGE',
        `Request body exceeds limit of ${limit} bytes`,
        { limit, length },
      );
    }
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > limit) {
    throw new RequestBodyError(
      'VALIDATION_BODY_TOO_LARGE',
      `Request body exceeds limit of ${limit} bytes`,
      { limit, length: buffer.byteLength },
    );
  }
  if (buffer.byteLength === 0) return undefined;
  const text = new TextDecoder().decode(buffer);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new RequestBodyError('VALIDATION_INVALID_JSON', 'Request body is not valid JSON', {
      cause: cause instanceof Error ? cause.message : 'parse error',
    });
  }
}

/** Flattens Express/Fastify-style header maps to a plain record of strings. */
export function normalizeHeaders(
  headers: Record<string, string | string[] | undefined> | Headers,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? (value[0] ?? '') : value;
  }
  return out;
}

/** Builds a ValidationError for a single part (used by sync Fastify validators). */
export function validationErrorForPart(
  part: RequestPart,
  issues: readonly ValidationIssue[],
  status: ValidationStatus = 400,
): ValidationError {
  const prefixed = issues.map((i) => {
    const path: PathKey[] = [part, ...i.path];
    return {
      ...i,
      path,
      pointer: `/${part}${i.pointer === '' ? '' : i.pointer}`,
    };
  });
  return new ValidationError(prefixed, { status, message: 'Validation failed' });
}
