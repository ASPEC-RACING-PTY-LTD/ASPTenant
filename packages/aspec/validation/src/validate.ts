import { ValidationError, ValidationSchemaError, type ValidationStatus } from './errors.js';
import {
  type MessageCustomizer,
  normalizeIssues,
  type PathKey,
  type ValidationIssue,
} from './issues.js';
import { type InferOutput, isStandardSchema, type StandardSchemaV1 } from './standard-schema.js';

/** Structured validation result. */
export type ValidationResult<T> =
  | { readonly success: true; readonly value: T; readonly issues?: undefined }
  | { readonly success: false; readonly issues: ValidationIssue[]; readonly value?: undefined };

export interface ValidateOptions {
  /** Message customisation (translation) hook or code-to-message map. */
  messages?: MessageCustomizer;
  /** Segments prepended to issue paths. */
  pathPrefix?: readonly PathKey[];
  /** Passed to the schema library as Standard Schema `libraryOptions`. */
  libraryOptions?: Record<string, unknown>;
}

export interface ParseOptions extends ValidateOptions {
  /** Status of the thrown ValidationError. Default 400. */
  status?: ValidationStatus;
  /** Message of the thrown ValidationError. Default `Validation failed`. */
  message?: string;
}

function assertSchema(schema: unknown): asserts schema is StandardSchemaV1 {
  if (!isStandardSchema(schema)) {
    throw new ValidationSchemaError(
      'VALIDATION_INVALID_SCHEMA',
      'Expected a Standard Schema v1 compatible schema (zod 4, valibot 1, ArkType, @aspec/validation/ajv, ...)',
    );
  }
}

function toResult<T>(
  result: StandardSchemaV1.Result<T>,
  input: unknown,
  options: ValidateOptions,
): ValidationResult<T> {
  if (result.issues === undefined || result.issues === null) {
    return { success: true, value: (result as StandardSchemaV1.SuccessResult<T>).value };
  }
  return {
    success: false,
    issues: normalizeIssues(result.issues, input, {
      messages: options.messages,
      pathPrefix: options.pathPrefix,
    }),
  };
}

function callOptions(options: ValidateOptions): StandardSchemaV1.Options | undefined {
  return options.libraryOptions ? { libraryOptions: options.libraryOptions } : undefined;
}

/** Validates `input` with any Standard Schema (sync or async). */
export async function validate<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
  options: ValidateOptions = {},
): Promise<ValidationResult<InferOutput<S>>> {
  assertSchema(schema);
  const result = await schema['~standard'].validate(input, callOptions(options));
  return toResult(result as StandardSchemaV1.Result<InferOutput<S>>, input, options);
}

/**
 * Validates synchronously. Throws ValidationSchemaError (`VALIDATION_ASYNC_SCHEMA`) when the
 * schema (or one of its refinements) is asynchronous.
 */
export function validateSync<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
  options: ValidateOptions = {},
): ValidationResult<InferOutput<S>> {
  assertSchema(schema);
  const result = schema['~standard'].validate(input, callOptions(options));
  if (result instanceof Promise) {
    result.catch(() => undefined);
    throw new ValidationSchemaError(
      'VALIDATION_ASYNC_SCHEMA',
      'Schema validation is asynchronous; use validate() instead of validateSync()',
    );
  }
  return toResult(result as StandardSchemaV1.Result<InferOutput<S>>, input, options);
}

/** Validates and returns the typed value, or throws ValidationError. */
export async function parse<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
  options: ParseOptions = {},
): Promise<InferOutput<S>> {
  const result = await validate(schema, input, options);
  if (result.success) return result.value;
  throw new ValidationError(result.issues, errorOptions(options));
}

/** Synchronous `parse`. */
export function parseSync<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
  options: ParseOptions = {},
): InferOutput<S> {
  const result = validateSync(schema, input, options);
  if (result.success) return result.value;
  throw new ValidationError(result.issues, errorOptions(options));
}

function errorOptions(options: ParseOptions): { status?: ValidationStatus; message?: string } {
  const out: { status?: ValidationStatus; message?: string } = {};
  if (options.status !== undefined) out.status = options.status;
  if (options.message !== undefined) out.message = options.message;
  return out;
}
