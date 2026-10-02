import {
  Ajv2020,
  type Options as AjvOptions,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import type { StandardSchemaV1 } from './standard-schema.js';

export interface JsonSchemaValidatorOptions {
  /**
   * Ajv constructor options. Defaults: `allErrors: true`, `strict: true`.
   * To enable format keywords, pass an Ajv instance via `instance` after registering
   * `ajv-formats` (or another formats plugin) yourself.
   */
  ajv?: AjvOptions;
  /** Existing Ajv 2020 instance. When set, `ajv` options are ignored. */
  instance?: Ajv2020;
  /** Vendor string exposed on `~standard`. Default `ajv`. */
  vendor?: string;
}

export interface JsonSchemaValidator<Output = unknown> extends StandardSchemaV1<unknown, Output> {
  readonly schema: Record<string, unknown>;
  readonly validateFn: ValidateFunction<Output>;
}

function issueFromError(
  err: ErrorObject,
): StandardSchemaV1.Issue & { code?: string; expected?: string } {
  const path = pointerToPath(err.instancePath);
  const message = err.message ?? 'Invalid value';
  const issue: StandardSchemaV1.Issue & { code?: string; expected?: string } = {
    message,
    path,
    code: err.keyword,
  };
  if (err.keyword === 'type' && typeof err.params.type === 'string') {
    issue.expected = err.params.type;
  } else if (err.keyword === 'enum' && Array.isArray(err.params.allowedValues)) {
    issue.expected = err.params.allowedValues.map(String).join(' | ');
  }
  return issue;
}

function pointerToPath(pointer: string): Array<string | number> {
  if (pointer === '' || pointer === undefined) return [];
  return pointer
    .replace(/^\//, '')
    .split('/')
    .filter((s) => s.length > 0)
    .map((seg) => {
      const decoded = seg.replace(/~1/g, '/').replace(/~0/g, '~');
      return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
    });
}

/**
 * Creates a Standard Schema v1 compatible validator from a JSON Schema (draft 2020-12)
 * using Ajv. Optional peer dependency: `ajv`.
 */
export function fromJsonSchema<Output = unknown>(
  schema: Record<string, unknown>,
  options: JsonSchemaValidatorOptions = {},
): JsonSchemaValidator<Output> {
  const ajv =
    options.instance ??
    new Ajv2020({
      allErrors: true,
      strict: true,
      validateSchema: true,
      ...options.ajv,
    });
  const validateFn = ajv.compile<Output>(schema);
  const validate = (value: unknown): StandardSchemaV1.Result<Output> => {
    const ok = validateFn(value);
    if (ok) return { value: value as Output };
    const issues = (validateFn.errors ?? []).map(issueFromError);
    return { issues };
  };
  return {
    schema,
    validateFn,
    '~standard': {
      version: 1,
      vendor: options.vendor ?? 'ajv',
      validate,
    },
  };
}
