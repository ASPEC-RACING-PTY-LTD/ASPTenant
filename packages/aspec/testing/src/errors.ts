export const TestingErrorCode = {
  INVALID_OPTION: 'TESTING_INVALID_OPTION',
  ASSERTION_FAILED: 'TESTING_ASSERTION_FAILED',
  UNSUPPORTED_APP: 'TESTING_UNSUPPORTED_APP',
  REQUEST_FAILED: 'TESTING_REQUEST_FAILED',
  UNMATCHED_REQUEST: 'TESTING_UNMATCHED_REQUEST',
  JWT_INVALID: 'TESTING_JWT_INVALID',
  FACTORY_UNKNOWN_TRAIT: 'TESTING_FACTORY_UNKNOWN_TRAIT',
  FACTORY_NO_ADAPTER: 'TESTING_FACTORY_NO_ADAPTER',
  SQL_MULTI_STATEMENT: 'TESTING_SQL_MULTI_STATEMENT',
  SQL_INVALID_IDENTIFIER: 'TESTING_SQL_INVALID_IDENTIFIER',
  FIXTURE_NOT_ACTIVE: 'TESTING_FIXTURE_NOT_ACTIVE',
  POSTGRES_DRIVER_MISSING: 'TESTING_POSTGRES_DRIVER_MISSING',
  PATH_OUTSIDE_ROOT: 'TESTING_PATH_OUTSIDE_ROOT',
  COVERAGE_SUMMARY_MISSING: 'TESTING_COVERAGE_SUMMARY_MISSING',
  COVERAGE_BELOW_THRESHOLD: 'TESTING_COVERAGE_BELOW_THRESHOLD',
  SCAFFOLD_INVALID_NAME: 'TESTING_SCAFFOLD_INVALID_NAME',
  SCAFFOLD_CONFLICT: 'TESTING_SCAFFOLD_CONFLICT',
  CLEANUP_FAILED: 'TESTING_CLEANUP_FAILED',
} as const;

export type TestingErrorCode = (typeof TestingErrorCode)[keyof typeof TestingErrorCode];

export interface TestingErrorOptions {
  status?: number;
  expose?: boolean;
  details?: unknown;
  cause?: unknown;
}

/** Base error for every failure raised by @aspec/testing. Satisfies the ErrorLike port. */
export class TestingError extends Error {
  readonly code: TestingErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(code: TestingErrorCode, message: string, options: TestingErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TestingError';
    this.code = code;
    this.status = options.status ?? 500;
    this.expose = options.expose ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * Assertion failure. Carries `actual` and `expected` so test runners that understand the
 * convention (Vitest, node:test, Jest) render their own structural diff next to ours.
 */
export class TestingAssertionError extends TestingError {
  readonly actual: unknown;
  readonly expected: unknown;
  readonly showDiff: boolean;

  constructor(message: string, actual?: unknown, expected?: unknown, showDiff = true) {
    super(TestingErrorCode.ASSERTION_FAILED, message);
    this.name = 'TestingAssertionError';
    this.actual = actual;
    this.expected = expected;
    this.showDiff = showDiff && (actual !== undefined || expected !== undefined);
  }
}

export function invalidOption(option: string, reason: string): TestingError {
  return new TestingError(TestingErrorCode.INVALID_OPTION, `Invalid option "${option}": ${reason}`);
}
