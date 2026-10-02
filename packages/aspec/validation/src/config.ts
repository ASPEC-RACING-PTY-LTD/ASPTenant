import { formatPath, type ValidationIssue } from './issues.js';
import type { InferOutput, StandardSchemaV1 } from './standard-schema.js';
import { type ValidateOptions, validate, validateSync } from './validate.js';

/** Keys whose validation messages are replaced (library messages may echo the value). */
export const SENSITIVE_CONFIG_KEY =
  /pass(word|phrase)?|secret|token|api[-_]?key|private|credential|dsn|salt/i;

export interface ConfigValidationOptions extends ValidateOptions {
  /** Name used in the report, for example the application or module name. */
  name?: string;
  /** Keys whose messages are replaced with a generic message. Default SENSITIVE_CONFIG_KEY. */
  sensitiveKeys?: RegExp;
}

/** Thrown when configuration is invalid. `report` lists every issue in readable form. */
export class ConfigValidationError extends Error {
  override name = 'ConfigValidationError';
  readonly code = 'VALIDATION_CONFIG_INVALID';
  readonly status = 500;
  readonly expose = false;
  readonly details: { issues: ValidationIssue[] };
  readonly report: string;

  constructor(issues: ValidationIssue[], report: string) {
    super(report);
    this.details = { issues };
    this.report = report;
  }

  get issues(): ValidationIssue[] {
    return this.details.issues;
  }
}

/** Formats issues as an indented list: `- server.port: Expected number, received string (invalid_type)`. */
export function formatIssues(issues: readonly ValidationIssue[], title?: string): string {
  const lines = issues.map((i) => {
    const where = i.path.length === 0 ? '(root)' : formatPath(i.path);
    return `  - ${where}: ${i.message} (${i.code})`;
  });
  return title === undefined ? lines.join('\n') : [title, ...lines].join('\n');
}

function sanitize(issues: ValidationIssue[], pattern: RegExp): ValidationIssue[] {
  return issues.map((i) =>
    i.path.some((seg) => typeof seg === 'string' && pattern.test(seg))
      ? { ...i, message: i.received === 'undefined' ? 'Required' : 'Invalid value' }
      : i,
  );
}

function fail(issues: ValidationIssue[], options: ConfigValidationOptions): never {
  const safe = sanitize(issues, options.sensitiveKeys ?? SENSITIVE_CONFIG_KEY);
  const label = options.name
    ? `Invalid configuration for ${options.name}`
    : 'Invalid configuration';
  const count = `${safe.length} issue${safe.length === 1 ? '' : 's'}`;
  throw new ConfigValidationError(safe, formatIssues(safe, `${label} (${count}):`));
}

/**
 * Validates configuration (for example an object built from `process.env`) and returns the
 * typed value. All issues are aggregated into one ConfigValidationError with a readable report.
 * Messages for sensitive keys never include library messages that could echo the value.
 */
export function validateConfig<S extends StandardSchemaV1>(
  schema: S,
  source: unknown,
  options: ConfigValidationOptions = {},
): InferOutput<S> {
  const result = validateSync(schema, source, options);
  if (result.success) return result.value;
  return fail(result.issues, options);
}

/** Asynchronous `validateConfig` for schemas with async rules. */
export async function validateConfigAsync<S extends StandardSchemaV1>(
  schema: S,
  source: unknown,
  options: ConfigValidationOptions = {},
): Promise<InferOutput<S>> {
  const result = await validate(schema, source, options);
  if (result.success) return result.value;
  return fail(result.issues, options);
}
