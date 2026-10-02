export const ObservabilityErrorCodes = {
  invalidConfig: 'OBSERVABILITY_INVALID_CONFIG',
  invalidMetricName: 'OBSERVABILITY_INVALID_METRIC_NAME',
  invalidLabels: 'OBSERVABILITY_INVALID_LABELS',
  metricConflict: 'OBSERVABILITY_METRIC_CONFLICT',
  invalidMetricValue: 'OBSERVABILITY_INVALID_METRIC_VALUE',
  healthCheckTimeout: 'OBSERVABILITY_HEALTH_CHECK_TIMEOUT',
  healthCheckFailed: 'OBSERVABILITY_HEALTH_CHECK_FAILED',
  destinationClosed: 'OBSERVABILITY_DESTINATION_CLOSED',
  shutdownTimeout: 'OBSERVABILITY_SHUTDOWN_TIMEOUT',
} as const;

export type ObservabilityErrorCode =
  (typeof ObservabilityErrorCodes)[keyof typeof ObservabilityErrorCodes];

export interface ObservabilityErrorOptions {
  status?: number;
  expose?: boolean;
  details?: unknown;
  cause?: unknown;
}

/**
 * Base class for every error thrown by @aspec/observability. The shape (code, status, expose)
 * satisfies the ErrorLike port so @aspec/errors can map it without an import dependency.
 */
export class ObservabilityError extends Error {
  readonly code: ObservabilityErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(
    code: ObservabilityErrorCode,
    message: string,
    options: ObservabilityErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ObservabilityError';
    this.code = code;
    this.status = options.status ?? 500;
    this.expose = options.expose ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** Invalid options passed to a factory. The message names the offending option. */
export class ObservabilityConfigError extends ObservabilityError {
  constructor(option: string, problem: string) {
    super(
      ObservabilityErrorCodes.invalidConfig,
      `Invalid observability option "${option}": ${problem}`,
      {
        status: 500,
        expose: false,
        details: { option },
      },
    );
    this.name = 'ObservabilityConfigError';
  }
}

export function configError(option: string, problem: string): ObservabilityConfigError {
  return new ObservabilityConfigError(option, problem);
}
