import { configError } from './errors.js';

export const ALGORITHMS = [
  'token-bucket',
  'gcra',
  'sliding-window',
  'sliding-log',
  'fixed-window',
] as const;

export type Algorithm = (typeof ALGORITHMS)[number];

/** How a store applies an operation. */
export type ConsumeMode = 'consume' | 'peek' | 'force';

/** Policy as written by the application. */
export interface RateLimitPolicyInput {
  /** Policy name used in keys and response headers. Default "default". */
  name?: string;
  /** Default "sliding-window". */
  algorithm?: Algorithm;
  /** Units allowed per window (for bucket algorithms: units refilled per window). */
  limit: number;
  /** Window length in milliseconds (for bucket algorithms: refill period for `limit` units). */
  windowMs: number;
  /** Bucket capacity for token-bucket and gcra. Default `limit`. Ignored by window algorithms. */
  burst?: number;
  /** Default cost of one consume call. Default 1. */
  cost?: number;
}

/** Normalised, validated policy. */
export interface RateLimitPolicy {
  readonly name: string;
  readonly algorithm: Algorithm;
  readonly limit: number;
  readonly windowMs: number;
  readonly burst: number;
  readonly cost: number;
}

/** Algorithm parameters passed to stores. */
export interface AlgorithmConfig {
  readonly algorithm: Algorithm;
  readonly limit: number;
  readonly windowMs: number;
  readonly burst: number;
}

export interface AlgorithmResult {
  allowed: boolean;
  /** Maximum units available at once (burst for bucket algorithms, limit otherwise). */
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs?: number;
}

export const POLICY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_SLIDING_LOG_LIMIT = 10_000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_LIMIT = 1_000_000_000;

function positiveInteger(option: string, value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw configError(option, `must be an integer between 1 and ${max}`);
  }
  return value;
}

export function normalizePolicy(input: RateLimitPolicyInput): RateLimitPolicy {
  if (input === null || typeof input !== 'object') {
    throw configError('policy', 'must be an object');
  }
  const name = input.name ?? 'default';
  if (typeof name !== 'string' || !POLICY_NAME_PATTERN.test(name)) {
    throw configError('policy.name', 'must match [A-Za-z0-9_.-]{1,64}');
  }
  const algorithm = input.algorithm ?? 'sliding-window';
  if (!(ALGORITHMS as readonly string[]).includes(algorithm)) {
    throw configError('policy.algorithm', `must be one of ${ALGORITHMS.join(', ')}`);
  }
  const limit = positiveInteger(
    'policy.limit',
    input.limit,
    algorithm === 'sliding-log' ? MAX_SLIDING_LOG_LIMIT : MAX_LIMIT,
  );
  const windowMs = positiveInteger('policy.windowMs', input.windowMs, MAX_WINDOW_MS);
  const bucket = algorithm === 'token-bucket' || algorithm === 'gcra';
  const burst = bucket ? positiveInteger('policy.burst', input.burst ?? limit, MAX_LIMIT) : limit;
  const cost = positiveInteger('policy.cost', input.cost ?? 1, burst);
  return Object.freeze({ name, algorithm, limit, windowMs, burst, cost });
}

export function algorithmConfig(policy: RateLimitPolicy): AlgorithmConfig {
  return {
    algorithm: policy.algorithm,
    limit: policy.limit,
    windowMs: policy.windowMs,
    burst: policy.burst,
  };
}

/** Seconds that the quota described by `RateLimit-Policy` spans. */
export function policyWindowSeconds(policy: RateLimitPolicy): number {
  if (policy.algorithm === 'token-bucket' || policy.algorithm === 'gcra') {
    return Math.max(1, Math.ceil((policy.burst * policy.windowMs) / policy.limit / 1000));
  }
  return Math.max(1, Math.ceil(policy.windowMs / 1000));
}

export interface TokenBucketState {
  tokens: number;
  updatedAt: number;
}
export interface GcraState {
  tat: number;
}
export interface WindowState {
  window: number;
  count: number;
  prev: number;
}
export interface LogState {
  entries: number[];
}
export type AlgorithmState = TokenBucketState | GcraState | WindowState | LogState;

export interface AlgorithmStep {
  result: AlgorithmResult;
  /** New state to persist, or undefined when the state did not change. */
  state: AlgorithmState | undefined;
  /** How long the persisted state must be kept. */
  ttlMs: number;
}

/**
 * Pure reference implementation of every algorithm. The memory store uses it directly and
 * the Redis Lua script mirrors it line by line.
 */
export function applyAlgorithm(
  config: AlgorithmConfig,
  state: AlgorithmState | undefined,
  cost: number,
  now: number,
  mode: ConsumeMode,
): AlgorithmStep {
  switch (config.algorithm) {
    case 'token-bucket':
      return tokenBucket(config, state as TokenBucketState | undefined, cost, now, mode);
    case 'gcra':
      return gcra(config, state as GcraState | undefined, cost, now, mode);
    case 'fixed-window':
      return fixedWindow(config, state as WindowState | undefined, cost, now, mode);
    case 'sliding-window':
      return slidingWindow(config, state as WindowState | undefined, cost, now, mode);
    case 'sliding-log':
      return slidingLog(config, state as LogState | undefined, cost, now, mode);
  }
}

function tokenBucket(
  c: AlgorithmConfig,
  s: TokenBucketState | undefined,
  cost: number,
  now: number,
  mode: ConsumeMode,
): AlgorithmStep {
  // Tokens refilled over `ms` and milliseconds needed for `tokens`, kept as exact as possible.
  const refilled = (ms: number): number => (ms * c.limit) / c.windowMs;
  const msFor = (n: number): number => Math.ceil((n * c.windowMs) / c.limit - 1e-9);
  let tokens = c.burst;
  if (s) {
    const elapsed = Math.max(0, now - s.updatedAt);
    tokens = Math.min(c.burst, s.tokens + refilled(elapsed));
  }
  let allowed = false;
  let retryAfterMs: number | undefined;
  let write = false;
  if (mode === 'force') {
    tokens -= cost;
    write = true;
    if (tokens >= 1) allowed = true;
    else retryAfterMs = msFor(1 - tokens);
  } else if (tokens >= cost) {
    allowed = true;
    if (mode === 'consume') {
      tokens -= cost;
      write = true;
    }
  } else {
    retryAfterMs = msFor(cost - tokens);
  }
  const refillMs = Math.max(0, msFor(c.burst - tokens));
  const result: AlgorithmResult = {
    allowed,
    limit: c.burst,
    remaining: Math.max(0, Math.floor(tokens)),
    resetAt: now + refillMs,
  };
  if (retryAfterMs !== undefined) result.retryAfterMs = Math.max(1, retryAfterMs);
  return {
    result,
    state: write ? { tokens, updatedAt: now } : undefined,
    ttlMs: refillMs + 1000,
  };
}

function gcra(
  c: AlgorithmConfig,
  s: GcraState | undefined,
  cost: number,
  now: number,
  mode: ConsumeMode,
): AlgorithmStep {
  const interval = c.windowMs / c.limit;
  const tolerance = interval * c.burst;
  const tat = s ? Math.max(s.tat, now) : now;
  const newTat = tat + interval * cost;
  const allowAt = newTat - tolerance;
  let allowed = false;
  let retryAfterMs: number | undefined;
  let stored = tat;
  let write = false;
  if (mode === 'force') {
    stored = newTat;
    write = true;
    const nextAllowAt = newTat + interval - tolerance;
    if (now >= nextAllowAt) allowed = true;
    else retryAfterMs = Math.ceil(nextAllowAt - now);
  } else if (now >= allowAt) {
    allowed = true;
    if (mode === 'consume') {
      stored = newTat;
      write = true;
    }
  } else {
    retryAfterMs = Math.ceil(allowAt - now);
  }
  const available = Math.floor((now - (stored - tolerance)) / interval + 1e-9);
  const result: AlgorithmResult = {
    allowed,
    limit: c.burst,
    remaining: Math.max(0, Math.min(c.burst, available)),
    resetAt: Math.ceil(Math.max(stored, now)),
  };
  if (retryAfterMs !== undefined) result.retryAfterMs = Math.max(1, retryAfterMs);
  return {
    result,
    state: write ? { tat: stored } : undefined,
    ttlMs: Math.ceil(Math.max(0, stored - now)) + 1000,
  };
}

function fixedWindow(
  c: AlgorithmConfig,
  s: WindowState | undefined,
  cost: number,
  now: number,
  mode: ConsumeMode,
): AlgorithmStep {
  const index = Math.floor(now / c.windowMs);
  const resetAt = (index + 1) * c.windowMs;
  let count = s && s.window === index ? s.count : 0;
  let allowed = false;
  let write = false;
  if (mode === 'force') {
    count += cost;
    write = true;
    allowed = count + 1 <= c.limit;
  } else if (count + cost <= c.limit) {
    allowed = true;
    if (mode === 'consume') {
      count += cost;
      write = true;
    }
  }
  const result: AlgorithmResult = {
    allowed,
    limit: c.limit,
    remaining: Math.max(0, c.limit - count),
    resetAt,
  };
  if (!allowed) result.retryAfterMs = Math.max(1, resetAt - now);
  return {
    result,
    state: write ? { window: index, count, prev: 0 } : undefined,
    ttlMs: resetAt - now + 1000,
  };
}

/** Milliseconds until a request of `cost` fits into the sliding window estimate. */
export function slidingWindowRetryMs(
  limit: number,
  windowMs: number,
  prev: number,
  curr: number,
  cost: number,
  elapsed: number,
): number {
  const budget = limit - cost;
  if (curr <= budget && prev > 0) {
    const wait = windowMs - elapsed - ((budget - curr) * windowMs) / prev;
    return Math.max(1, Math.ceil(wait));
  }
  const intoNext = curr > 0 ? Math.max(0, windowMs - (budget * windowMs) / curr) : 0;
  return Math.max(1, Math.ceil(windowMs - elapsed + intoNext));
}

function slidingWindow(
  c: AlgorithmConfig,
  s: WindowState | undefined,
  cost: number,
  now: number,
  mode: ConsumeMode,
): AlgorithmStep {
  const index = Math.floor(now / c.windowMs);
  const start = index * c.windowMs;
  const elapsed = now - start;
  let curr = 0;
  let prev = 0;
  if (s) {
    if (s.window === index) {
      curr = s.count;
      prev = s.prev;
    } else if (s.window === index - 1) {
      prev = s.count;
    }
  }
  const weight = (c.windowMs - elapsed) / c.windowMs;
  const estimate = prev * weight + curr;
  let allowed = false;
  let write = false;
  let used = estimate;
  if (mode === 'force') {
    curr += cost;
    used = estimate + cost;
    write = true;
    allowed = used + 1 <= c.limit;
  } else if (estimate + cost <= c.limit) {
    allowed = true;
    if (mode === 'consume') {
      curr += cost;
      used = estimate + cost;
      write = true;
    }
  }
  const result: AlgorithmResult = {
    allowed,
    limit: c.limit,
    remaining: Math.max(0, Math.floor(c.limit - used + 1e-9)),
    resetAt: start + c.windowMs,
  };
  if (!allowed) {
    const retry = slidingWindowRetryMs(
      c.limit,
      c.windowMs,
      prev,
      curr,
      mode === 'force' ? 1 : cost,
      elapsed,
    );
    result.retryAfterMs = retry;
    result.resetAt = now + retry;
  }
  return {
    result,
    state: write ? { window: index, count: curr, prev } : undefined,
    ttlMs: start + 2 * c.windowMs - now + 1000,
  };
}

function slidingLog(
  c: AlgorithmConfig,
  s: LogState | undefined,
  cost: number,
  now: number,
  mode: ConsumeMode,
): AlgorithmStep {
  const cutoff = now - c.windowMs;
  const entries = s ? s.entries.filter((t) => t > cutoff) : [];
  const pruned = s !== undefined && entries.length !== s.entries.length;
  let allowed = false;
  let write = pruned;
  const need = mode === 'force' ? 1 : cost;
  if (mode === 'force') {
    for (let i = 0; i < cost; i++) entries.push(now);
    while (entries.length > c.limit * 2) entries.shift();
    write = true;
    allowed = entries.length + 1 <= c.limit;
  } else if (entries.length + cost <= c.limit) {
    allowed = true;
    if (mode === 'consume') {
      for (let i = 0; i < cost; i++) entries.push(now);
      write = true;
    }
  }
  entries.sort((a, b) => a - b);
  const oldest = entries[0];
  const newest = entries[entries.length - 1];
  const result: AlgorithmResult = {
    allowed,
    limit: c.limit,
    remaining: Math.max(0, c.limit - entries.length),
    resetAt: (oldest ?? now) + c.windowMs,
  };
  if (!allowed) {
    const pivot = entries[entries.length + need - c.limit - 1] ?? now;
    const retry = Math.max(1, pivot + c.windowMs - now);
    result.retryAfterMs = retry;
    result.resetAt = now + retry;
  }
  return {
    result,
    state: write ? { entries } : undefined,
    ttlMs: (newest ?? now) + c.windowMs - now + 1000,
  };
}
