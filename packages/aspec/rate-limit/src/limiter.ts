import { createHash } from 'node:crypto';
import {
  type AlgorithmConfig,
  algorithmConfig,
  normalizePolicy,
  type RateLimitPolicy,
  type RateLimitPolicyInput,
} from './algorithms.js';
import { type CircuitBreakerOptions, type CircuitState, createCircuitBreaker } from './circuit.js';
import { argumentError, configError, RateLimitExceededError } from './errors.js';
import { AccessList, type AccessListInput } from './ip.js';
import type { AuditSink, Clock, LoggerLike, RateLimitDecision, RateLimiterLike } from './ports.js';
import type { BanState, PenaltyConfig, RateLimitStore, StoreResult } from './store.js';

export type FailureMode = 'open' | 'closed';

/** Why a decision was denied (or allowed without consulting the store). */
export type DecisionReason =
  | 'limit'
  | 'banned'
  | 'denylist'
  | 'allowlist'
  | 'store_unavailable'
  | 'fail_open';

export interface RateLimitResult extends RateLimitDecision {
  /** Name of the policy that produced the decision. */
  policy: string;
  /** Milliseconds until `resetAt`, measured on the store's clock. */
  resetAfterMs: number;
  /** Set for decisions that were not a plain allowed consumption. */
  reason?: DecisionReason;
  /** Present when the key is currently banned by the penalty box. */
  ban?: BanState;
}

export interface PenaltyBoxOptions {
  /** Limit violations inside `violationWindowMs` that trigger a ban. Default 5. */
  threshold?: number;
  /** Default 60000. */
  violationWindowMs?: number;
  /** First ban duration. Default 60000. */
  banMs?: number;
  /** Escalation factor for repeated bans. Default 2. */
  multiplier?: number;
  /** Upper bound for a ban. Default 86400000 (24 hours). */
  maxBanMs?: number;
  /** How long the escalation level is remembered after a ban ends. Default 86400000. */
  decayMs?: number;
}

export interface LimitReachedEvent {
  key: string;
  policy: string;
  decision: RateLimitResult;
}

export interface BanEvent {
  key: string;
  policy: string;
  until: number;
  level: number;
  durationMs: number;
  manual: boolean;
}

export interface RateLimiterOptions {
  store: RateLimitStore;
  policy: RateLimitPolicyInput;
  /** Behaviour when the store fails. Default "open" (allow). Use "closed" for authentication. */
  failureMode?: FailureMode;
  /** Circuit breaker around store calls. Pass false to disable. */
  circuitBreaker?: CircuitBreakerOptions | false;
  /** Temporary bans after repeated violations. Disabled unless provided. */
  penalty?: PenaltyBoxOptions | false;
  /** Check the ban list on every consume even without automatic penalties. Default: true when `penalty` is set. */
  checkBans?: boolean;
  /** Keys (or IPs when the key is an IP) that bypass the limit. */
  allowlist?: AccessListInput;
  /** Keys (or IPs when the key is an IP) that are always rejected. */
  denylist?: AccessListInput;
  onLimitReached?: (event: LimitReachedEvent) => void | Promise<void>;
  onBan?: (event: BanEvent) => void | Promise<void>;
  /** Records `rate_limit.banned` events. */
  audit?: AuditSink;
  logger?: LoggerLike;
  /** Clock used for circuit breaker timing and store-independent decisions. */
  clock?: Clock;
}

export interface RateLimiter extends RateLimiterLike {
  readonly policy: RateLimitPolicy;
  /** Consumes `cost` units (default: the policy cost). */
  consume(key: string, cost?: number): Promise<RateLimitResult>;
  /** Reports whether one unit would be allowed without consuming anything. */
  peek(key: string): Promise<RateLimitResult>;
  /** Clears the key's counters and violation count (bans stay). */
  reset(key: string): Promise<void>;
  /** Consumes `cost` units even when that exceeds the limit (for example after a failed login). */
  penalize(key: string, cost?: number): Promise<RateLimitResult>;
  /** Like consume, but throws RateLimitExceededError when the operation is not allowed. */
  limit(key: string, cost?: number): Promise<RateLimitResult>;
  ban(key: string, durationMs?: number): Promise<BanState>;
  unban(key: string): Promise<void>;
  getBan(key: string): Promise<BanState | undefined>;
  readonly circuitState: CircuitState;
}

const noopLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const MAX_KEY_LENGTH = 512;
const HASH_KEYS_LONGER_THAN = 200;

function normalizePenalty(input: PenaltyBoxOptions): PenaltyConfig {
  const read = (name: keyof PenaltyBoxOptions, fallback: number, min: number): number => {
    const value = input[name] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
      throw configError(`penalty.${name}`, `must be a number of at least ${min}`);
    }
    return value;
  };
  const config: PenaltyConfig = {
    threshold: Math.floor(read('threshold', 5, 1)),
    violationWindowMs: Math.floor(read('violationWindowMs', 60_000, 1)),
    banMs: Math.floor(read('banMs', 60_000, 1)),
    multiplier: read('multiplier', 2, 1),
    maxBanMs: Math.floor(read('maxBanMs', 86_400_000, 1)),
    decayMs: Math.floor(read('decayMs', 86_400_000, 0)),
  };
  if (config.maxBanMs < config.banMs) throw configError('penalty.maxBanMs', 'must be >= banMs');
  return config;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Creates a rate limiter for one policy. Implements the RateLimiterLike port. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  if (!options || typeof options !== 'object') throw configError('options', 'must be an object');
  const store = options.store;
  if (!store || typeof store.apply !== 'function') {
    throw configError('store', 'must implement RateLimitStore');
  }
  const policy = normalizePolicy(options.policy);
  const config: AlgorithmConfig = algorithmConfig(policy);
  const failureMode = options.failureMode ?? 'open';
  if (failureMode !== 'open' && failureMode !== 'closed') {
    throw configError('failureMode', 'must be "open" or "closed"');
  }
  const penalty = options.penalty ? normalizePenalty(options.penalty) : undefined;
  const checkBans = options.checkBans ?? penalty !== undefined;
  const allowlist = new AccessList(options.allowlist, 'allowlist');
  const denylist = new AccessList(options.denylist, 'denylist');
  const logger = options.logger ?? noopLogger;
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const breaker = createCircuitBreaker(options.circuitBreaker, clock, (state, error) => {
    if (state === 'open') {
      logger.error(
        { policy: policy.name, failureMode, err: errorMessage(error) },
        'rate-limit store circuit opened',
      );
    } else if (state === 'closed') {
      logger.info({ policy: policy.name }, 'rate-limit store circuit closed');
    }
  });

  const storeKey = (key: string, argument = 'key'): string => {
    if (typeof key !== 'string' || key.length === 0) {
      throw argumentError(argument, 'must be a non-empty string');
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw argumentError(argument, `must be at most ${MAX_KEY_LENGTH} characters`);
    }
    const safe =
      key.length > HASH_KEYS_LONGER_THAN
        ? `h:${createHash('sha256').update(key).digest('base64url')}`
        : key;
    return `${policy.name}:${safe}`;
  };

  const checkCost = (cost: number | undefined): number => {
    const value = cost ?? policy.cost;
    if (!Number.isInteger(value) || value < 1) {
      throw argumentError('cost', 'must be a positive integer');
    }
    return value;
  };

  const toResult = (r: StoreResult, reason?: DecisionReason): RateLimitResult => {
    const result: RateLimitResult = {
      allowed: r.allowed,
      limit: r.limit,
      remaining: r.remaining,
      resetAt: r.resetAt,
      policy: policy.name,
      resetAfterMs: Math.max(0, r.resetAt - r.now),
    };
    if (r.retryAfterMs !== undefined) result.retryAfterMs = r.retryAfterMs;
    if (reason !== undefined) result.reason = reason;
    else if (!r.allowed) result.reason = 'limit';
    return result;
  };

  const syntheticResult = (allowed: boolean, reason: DecisionReason): RateLimitResult => {
    const now = clock.now();
    const result: RateLimitResult = {
      allowed,
      limit: config.burst,
      remaining: allowed ? config.burst : 0,
      resetAt: now + policy.windowMs,
      policy: policy.name,
      resetAfterMs: policy.windowMs,
      reason,
    };
    if (!allowed && reason === 'store_unavailable') {
      const retry = Math.max(1000, breaker.retryInMs());
      result.retryAfterMs = retry;
      result.resetAt = now + retry;
      result.resetAfterMs = retry;
    }
    return result;
  };

  const storeFailure = (error: unknown, operation: string): RateLimitResult => {
    if (breaker.state === 'closed') {
      logger.warn(
        { policy: policy.name, operation, failureMode, err: errorMessage(error) },
        'rate-limit store error',
      );
    }
    return failureMode === 'open'
      ? syntheticResult(true, 'fail_open')
      : syntheticResult(false, 'store_unavailable');
  };

  const safeHook = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      logger.error({ policy: policy.name, hook: name, err: errorMessage(error) }, 'hook failed');
    }
  };

  const announceBan = async (key: string, ban: BanState, now: number, manual: boolean) => {
    const event: BanEvent = {
      key,
      policy: policy.name,
      until: ban.until,
      level: ban.level,
      durationMs: Math.max(0, ban.until - now),
      manual,
    };
    logger.warn(
      { policy: policy.name, level: ban.level, durationMs: event.durationMs, manual },
      'rate-limit ban applied',
    );
    const { onBan, audit } = options;
    if (onBan) await safeHook('onBan', () => onBan(event));
    if (audit) {
      await safeHook('audit', async () => {
        await audit.record({
          action: 'rate_limit.banned',
          outcome: 'denied',
          category: 'security',
          resource: { type: 'rate_limit_key', id: key },
          metadata: {
            policy: policy.name,
            until: ban.until,
            level: ban.level,
            durationMs: event.durationMs,
            manual,
          },
        });
      });
    }
  };

  const bannedResult = (ban: BanState, now: number): RateLimitResult => ({
    allowed: false,
    limit: config.burst,
    remaining: 0,
    resetAt: ban.until,
    retryAfterMs: Math.max(1, ban.until - now),
    resetAfterMs: Math.max(0, ban.until - now),
    policy: policy.name,
    reason: 'banned',
    ban,
  });

  const evaluate = async (
    key: string,
    cost: number,
    mode: 'consume' | 'peek' | 'force',
  ): Promise<RateLimitResult> => {
    const k = storeKey(key);
    if (mode !== 'force') {
      if (denylist.matches(key)) return syntheticResult(false, 'denylist');
      if (allowlist.matches(key)) return syntheticResult(true, 'allowlist');
    }
    let stored: StoreResult;
    try {
      if (checkBans && mode !== 'force') {
        const lookup = await breaker.run(() => store.getBan(k));
        if (lookup.ban) return bannedResult(lookup.ban, lookup.now);
      }
      stored = await breaker.run(() => store.apply({ key: k, config, cost, mode }));
    } catch (error) {
      return storeFailure(error, mode);
    }
    const result = toResult(stored);
    if (mode === 'consume' && !stored.allowed) {
      const { onLimitReached } = options;
      if (onLimitReached) {
        await safeHook('onLimitReached', () =>
          onLimitReached({ key, policy: policy.name, decision: result }),
        );
      }
      if (penalty) {
        try {
          const violation = await breaker.run(() => store.recordViolation(k, penalty));
          if (violation.ban) {
            await announceBan(key, violation.ban, violation.now, false);
            return bannedResult(violation.ban, violation.now);
          }
        } catch (error) {
          logger.warn(
            { policy: policy.name, err: errorMessage(error) },
            'rate-limit penalty update failed',
          );
        }
      }
    }
    return result;
  };

  const limiter: RateLimiter = {
    policy,
    get circuitState() {
      return breaker.state;
    },
    async consume(key, cost) {
      return evaluate(key, checkCost(cost), 'consume');
    },
    async peek(key) {
      return evaluate(key, 1, 'peek');
    },
    async penalize(key, cost) {
      return evaluate(key, checkCost(cost ?? 1), 'force');
    },
    async limit(key, cost) {
      const result = await evaluate(key, checkCost(cost), 'consume');
      if (!result.allowed)
        throw new RateLimitExceededError(policy.name, result, result.reason ?? 'limit');
      return result;
    },
    async reset(key) {
      await store.reset(storeKey(key));
    },
    async ban(key, durationMs) {
      const duration = durationMs ?? penalty?.banMs ?? 60_000;
      if (!Number.isInteger(duration) || duration < 1) {
        throw argumentError('durationMs', 'must be a positive integer');
      }
      const ban = await store.setBan(storeKey(key), duration, penalty?.decayMs ?? 86_400_000);
      await announceBan(key, ban, ban.until - duration, true);
      return ban;
    },
    async unban(key) {
      await store.clearBan(storeKey(key));
    },
    async getBan(key) {
      return (await store.getBan(storeKey(key))).ban;
    },
  };
  return limiter;
}
