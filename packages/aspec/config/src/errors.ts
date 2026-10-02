export const CONFIG_ERROR_CODES = [
  'CONFIG_INVALID',
  'CONFIG_PROVIDER_ERROR',
  'CONFIG_LOAD_ERROR',
] as const;
export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[number];

export interface ConfigIssue {
  /** Environment variable or path, for example `PORT` or `database.url`. */
  path: string;
  /** Machine-readable problem id. */
  problem: string;
  /** Human message that never includes secret values. */
  message: string;
  /** Optional remediation hint. */
  hint?: string;
}

/** Aggregated configuration failure. Satisfies the ErrorLike port. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details: { issues: ConfigIssue[] };

  constructor(
    code: ConfigErrorCode,
    message: string,
    issues: ConfigIssue[] = [],
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ConfigError';
    this.code = code;
    this.status = code === 'CONFIG_INVALID' ? 500 : 502;
    this.expose = code === 'CONFIG_INVALID';
    this.details = { issues };
  }

  /** Human multi-line report (never includes secret values). */
  toReport(): string {
    const lines = [`Configuration invalid (${this.details.issues.length} issue(s)):`];
    for (const issue of this.details.issues) {
      lines.push(`  - ${issue.path}: ${issue.message}${issue.hint ? ` (${issue.hint})` : ''}`);
    }
    return lines.join('\n');
  }

  /** JSON report suitable for CI. */
  toJSON(): { code: ConfigErrorCode; message: string; issues: ConfigIssue[] } {
    return { code: this.code, message: this.message, issues: this.details.issues };
  }
}

export function isConfigError(value: unknown): value is ConfigError {
  return value instanceof ConfigError;
}
