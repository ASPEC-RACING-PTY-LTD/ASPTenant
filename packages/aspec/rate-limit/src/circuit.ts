import { configError, RateLimitError } from './errors.js';
import type { Clock } from './ports.js';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. Default 5. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial call is allowed. Default 30000. */
  resetTimeoutMs?: number;
  /** Per-call timeout; slower store calls count as failures. Default 1000. */
  timeoutMs?: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreaker {
  readonly state: CircuitState;
  /** Runs fn unless the circuit is open. Throws RATE_LIMIT_STORE_ERROR when skipped. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Milliseconds until the next trial call is allowed (0 when not open). */
  retryInMs(): number;
}

export function createCircuitBreaker(
  options: CircuitBreakerOptions | false | undefined,
  clock: Clock,
  onStateChange: (state: CircuitState, error?: unknown) => void,
): CircuitBreaker {
  const enabled = options !== false;
  const opts = options === false ? {} : (options ?? {});
  const failureThreshold = opts.failureThreshold ?? 5;
  const resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 1000;
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw configError('circuitBreaker.failureThreshold', 'must be a positive integer');
  }
  if (!Number.isInteger(resetTimeoutMs) || resetTimeoutMs < 1) {
    throw configError('circuitBreaker.resetTimeoutMs', 'must be a positive integer');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw configError('circuitBreaker.timeoutMs', 'must be a positive integer');
  }

  let state: CircuitState = 'closed';
  let failures = 0;
  let openedAt = 0;
  let trialInFlight = false;

  const transition = (next: CircuitState, error?: unknown): void => {
    if (state === next) return;
    state = next;
    onStateChange(next, error);
  };

  const withTimeout = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new RateLimitError(
            'RATE_LIMIT_STORE_ERROR',
            `Store call timed out after ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      fn().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  return {
    get state() {
      if (state === 'open' && clock.now() - openedAt >= resetTimeoutMs) return 'half-open';
      return state;
    },
    retryInMs() {
      if (state !== 'open') return 0;
      return Math.max(0, openedAt + resetTimeoutMs - clock.now());
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (!enabled) return fn();
      let trial = false;
      if (state !== 'closed') {
        if (clock.now() - openedAt < resetTimeoutMs || trialInFlight) {
          throw new RateLimitError('RATE_LIMIT_STORE_ERROR', 'Rate limit store circuit is open');
        }
        trial = true;
        trialInFlight = true;
        transition('half-open');
      }
      try {
        const value = await withTimeout(fn);
        failures = 0;
        transition('closed');
        return value;
      } catch (error) {
        failures++;
        if (trial || failures >= failureThreshold) {
          openedAt = clock.now();
          transition('open', error);
        }
        throw error;
      } finally {
        if (trial) trialInFlight = false;
      }
    },
  };
}
