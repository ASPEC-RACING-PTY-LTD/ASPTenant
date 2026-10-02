import { configError } from './errors.js';
import type { Clock, RateLimitDecision, RateLimiterLike } from './ports.js';

export interface MemoryRateLimiterOptions {
  /** Maximum cost allowed per key within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Upper bound on tracked keys; the oldest windows are evicted beyond it. Default 50000. */
  maxKeys?: number;
  clock?: Clock;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * In-process fixed-window rate limiter satisfying RateLimiterLike. Suitable for a single
 * process; use @aspec/rate-limit (or any shared RateLimiterLike) when running several instances.
 */
export function createMemoryRateLimiter(options: MemoryRateLimiterOptions): RateLimiterLike {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? 50_000;
  const clock = options.clock ?? { now: () => Date.now() };
  if (!Number.isInteger(limit) || limit < 1)
    configError('rateLimit.limit', 'must be a positive integer');
  if (!Number.isInteger(windowMs) || windowMs < 1)
    configError('rateLimit.windowMs', 'must be a positive integer');
  const windows = new Map<string, Window>();
  let lastSweep = 0;

  const sweep = (now: number) => {
    if (now - lastSweep < windowMs && windows.size < maxKeys) return;
    lastSweep = now;
    for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
    // Map iteration order is insertion order, so the first keys are the oldest windows.
    while (windows.size >= maxKeys) {
      const first = windows.keys().next();
      if (first.done) break;
      windows.delete(first.value);
    }
  };

  return {
    async consume(key, cost = 1): Promise<RateLimitDecision> {
      const now = clock.now();
      sweep(now);
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        windows.delete(key);
        w = { count: 0, resetAt: now + windowMs };
        windows.set(key, w);
      }
      if (w.count + cost > limit) {
        return {
          allowed: false,
          limit,
          remaining: Math.max(0, limit - w.count),
          resetAt: w.resetAt,
          retryAfterMs: w.resetAt - now,
        };
      }
      w.count += cost;
      return { allowed: true, limit, remaining: limit - w.count, resetAt: w.resetAt };
    },
  };
}
