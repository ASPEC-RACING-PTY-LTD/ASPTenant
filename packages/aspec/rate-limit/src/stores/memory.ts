import { type AlgorithmState, applyAlgorithm } from '../algorithms.js';
import { configError } from '../errors.js';
import type { Clock } from '../ports.js';
import type {
  BanLookup,
  BanState,
  PenaltyConfig,
  RateLimitStore,
  StoreOperation,
  StoreResult,
  ViolationResult,
} from '../store.js';

export interface MemoryStoreOptions {
  /** Maximum number of tracked keys (least recently used keys are evicted). Default 100000. */
  maxKeys?: number;
  /** Interval of the expired-entry sweep. Default 60000. The timer is unref'd. */
  sweepIntervalMs?: number;
  clock?: Clock;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** Map with LRU eviction and per-entry expiry. */
class BoundedMap<V> {
  readonly #map = new Map<string, Entry<V>>();
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  get(key: string, now: number): V | undefined {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.#map.delete(key);
      return undefined;
    }
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, expiresAt: number): void {
    this.#map.delete(key);
    this.#map.set(key, { value, expiresAt });
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      this.#map.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.#map.delete(key);
  }

  sweep(now: number): void {
    for (const [key, entry] of this.#map) {
      if (entry.expiresAt <= now) this.#map.delete(key);
    }
  }

  clear(): void {
    this.#map.clear();
  }

  get size(): number {
    return this.#map.size;
  }
}

export interface MemoryRateLimitStore extends RateLimitStore {
  /** Number of tracked algorithm states. */
  size(): number;
  /** Removes every entry. */
  clear(): void;
  /** Runs the expiry sweep immediately. */
  sweep(): void;
  close(): Promise<void>;
}

interface Violations {
  count: number;
}

/**
 * In-memory store for single-process deployments and tests. State is lost on restart and
 * not shared between processes; use the Redis store for distributed limits.
 */
export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryRateLimitStore {
  const maxKeys = options.maxKeys ?? 100_000;
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw configError('maxKeys', 'must be a positive integer');
  }
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  if (!Number.isInteger(sweepIntervalMs) || sweepIntervalMs < 1000) {
    throw configError('sweepIntervalMs', 'must be an integer of at least 1000');
  }
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const states = new BoundedMap<AlgorithmState>(maxKeys);
  const violations = new BoundedMap<Violations>(maxKeys);
  const bans = new BoundedMap<BanState>(maxKeys);

  const sweep = (): void => {
    const now = clock.now();
    states.sweep(now);
    violations.sweep(now);
    bans.sweep(now);
  };
  let timer: ReturnType<typeof setInterval> | undefined = setInterval(sweep, sweepIntervalMs);
  timer.unref?.();

  const activeBan = (key: string, now: number): BanState | undefined => {
    const ban = bans.get(key, now);
    return ban && ban.until > now ? { ...ban } : undefined;
  };

  return {
    async apply(op: StoreOperation): Promise<StoreResult> {
      const now = clock.now();
      const step = applyAlgorithm(op.config, states.get(op.key, now), op.cost, now, op.mode);
      if (step.state) states.set(op.key, step.state, now + step.ttlMs);
      return { ...step.result, now };
    },
    async reset(key: string): Promise<void> {
      states.delete(key);
      violations.delete(key);
    },
    async recordViolation(key: string, config: PenaltyConfig): Promise<ViolationResult> {
      const now = clock.now();
      const current = violations.get(key, now);
      const count = (current?.count ?? 0) + 1;
      if (count < config.threshold) {
        if (current) current.count = count;
        else violations.set(key, { count }, now + config.violationWindowMs);
        return { violations: count, now };
      }
      violations.delete(key);
      const previous = bans.get(key, now);
      const level = (previous?.level ?? 0) + 1;
      const duration = Math.floor(
        Math.min(config.maxBanMs, config.banMs * config.multiplier ** (level - 1)),
      );
      const ban: BanState = { until: now + duration, level };
      bans.set(key, ban, now + duration + config.decayMs);
      return { violations: count, ban: { ...ban }, now };
    },
    async getBan(key: string): Promise<BanLookup> {
      const now = clock.now();
      return { ban: activeBan(key, now), now };
    },
    async setBan(key: string, durationMs: number, decayMs: number): Promise<BanState> {
      const now = clock.now();
      const previous = bans.get(key, now);
      const ban: BanState = { until: now + durationMs, level: Math.max(1, previous?.level ?? 0) };
      bans.set(key, ban, now + durationMs + decayMs);
      return { ...ban };
    },
    async clearBan(key: string): Promise<void> {
      bans.delete(key);
      violations.delete(key);
    },
    size: () => states.size,
    clear(): void {
      states.clear();
      violations.clear();
      bans.clear();
    },
    sweep,
    async close(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
