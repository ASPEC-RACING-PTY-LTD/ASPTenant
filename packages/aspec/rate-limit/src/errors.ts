import type { RateLimitDecision } from './ports.js';

export type RateLimitErrorCode =
  | 'RATE_LIMIT_INVALID_CONFIG'
  | 'RATE_LIMIT_INVALID_ARGUMENT'
  | 'RATE_LIMIT_EXCEEDED'
  | 'RATE_LIMIT_STORE_ERROR';

export interface RateLimitErrorOptions {
  status?: number;
  expose?: boolean;
  details?: unknown;
  cause?: unknown;
}

/** Base error for the module. Satisfies the ErrorLike port. */
export class RateLimitError extends Error {
  readonly code: RateLimitErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details: unknown;

  constructor(code: RateLimitErrorCode, message: string, options: RateLimitErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RateLimitError';
    this.code = code;
    this.status = options.status ?? 500;
    this.expose = options.expose ?? false;
    this.details = options.details;
  }
}

export function configError(option: string, message: string): RateLimitError {
  return new RateLimitError(
    'RATE_LIMIT_INVALID_CONFIG',
    `Invalid rate-limit option "${option}": ${message}`,
    {
      status: 500,
      details: { option },
    },
  );
}

export function argumentError(argument: string, message: string): RateLimitError {
  return new RateLimitError(
    'RATE_LIMIT_INVALID_ARGUMENT',
    `Invalid argument "${argument}": ${message}`,
    {
      status: 400,
      details: { argument },
    },
  );
}

/** Thrown by `limiter.limit()` when the operation is not allowed. */
export class RateLimitExceededError extends RateLimitError {
  readonly decision: RateLimitDecision;
  readonly retryAfterMs: number | undefined;
  readonly policy: string;

  constructor(policy: string, decision: RateLimitDecision, reason: string) {
    const seconds =
      decision.retryAfterMs === undefined ? undefined : Math.ceil(decision.retryAfterMs / 1000);
    super(
      'RATE_LIMIT_EXCEEDED',
      seconds === undefined
        ? `Rate limit exceeded for policy "${policy}".`
        : `Rate limit exceeded for policy "${policy}". Retry after ${seconds} seconds.`,
      {
        status: reason === 'store_unavailable' ? 503 : 429,
        expose: true,
        details: { policy, reason, retryAfter: seconds },
      },
    );
    this.name = 'RateLimitExceededError';
    this.decision = decision;
    this.retryAfterMs = decision.retryAfterMs;
    this.policy = policy;
  }
}
