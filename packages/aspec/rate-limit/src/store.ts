import type { AlgorithmConfig, AlgorithmResult, ConsumeMode } from './algorithms.js';

export interface StoreOperation {
  /** Fully qualified limiter key (policy name and caller key). */
  key: string;
  config: AlgorithmConfig;
  cost: number;
  mode: ConsumeMode;
}

/** Algorithm result plus the store's notion of the current time. */
export interface StoreResult extends AlgorithmResult {
  now: number;
}

export interface PenaltyConfig {
  /** Violations inside `violationWindowMs` that trigger a ban. */
  threshold: number;
  violationWindowMs: number;
  /** Ban duration for the first ban. */
  banMs: number;
  /** Each repeated ban multiplies the previous duration by this factor. */
  multiplier: number;
  maxBanMs: number;
  /** How long the escalation level is remembered after a ban ends. */
  decayMs: number;
}

export interface BanState {
  /** Epoch ms when the ban ends. */
  until: number;
  /** Escalation level, 1 for the first ban. */
  level: number;
}

export interface BanLookup {
  ban: BanState | undefined;
  now: number;
}

export interface ViolationResult {
  violations: number;
  /** Present when this violation started a new ban. */
  ban?: BanState;
  now: number;
}

/**
 * Storage backend for rate limit state. Every method must be atomic per key so that
 * concurrent consumers never exceed the limit. Stores own their clock: the memory store
 * uses an injected clock and the Redis store uses server time by default.
 */
export interface RateLimitStore {
  apply(operation: StoreOperation): Promise<StoreResult>;
  /** Removes algorithm state and violation counters for the key (bans are kept). */
  reset(key: string): Promise<void>;
  recordViolation(key: string, config: PenaltyConfig): Promise<ViolationResult>;
  getBan(key: string): Promise<BanLookup>;
  setBan(key: string, durationMs: number, decayMs: number): Promise<BanState>;
  clearBan(key: string): Promise<void>;
  close?(): Promise<void>;
}
