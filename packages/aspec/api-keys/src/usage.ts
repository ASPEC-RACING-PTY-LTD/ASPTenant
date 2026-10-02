import type { LoggerLike } from './ports.js';
import type { ApiKeysStore } from './store.js';
import type { UsageDelta } from './types.js';

export interface UsageTrackerOptions {
  store: ApiKeysStore;
  /** Flush interval. Default 5000. */
  flushIntervalMs?: number;
  logger?: LoggerLike;
  /** Max pending public IDs before a forced flush. Default 1000. */
  maxPending?: number;
}

export interface UsageTracker {
  record(publicId: string, at: number, ip: string | null): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const noopLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Batches last-used / use-count writes and flushes on an interval or shutdown. */
export function createUsageTracker(options: UsageTrackerOptions): UsageTracker {
  const flushIntervalMs = options.flushIntervalMs ?? 5000;
  const maxPending = options.maxPending ?? 1000;
  const logger = options.logger ?? noopLogger;
  const pending = new Map<string, UsageDelta>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const flush = async (): Promise<void> => {
    if (pending.size === 0) return;
    const deltas = [...pending.values()];
    pending.clear();
    try {
      await options.store.applyUsage(deltas);
    } catch (err) {
      // Re-queue on failure so usage is not silently lost.
      for (const d of deltas) {
        const existing = pending.get(d.publicId);
        if (!existing) pending.set(d.publicId, d);
        else {
          existing.increment += d.increment;
          if (d.lastUsedAt >= existing.lastUsedAt) {
            existing.lastUsedAt = d.lastUsedAt;
            existing.lastUsedIp = d.lastUsedIp;
          }
        }
      }
      logger.error(
        { err: err instanceof Error ? err.message : String(err), count: deltas.length },
        'api-keys usage flush failed',
      );
    }
  };

  if (flushIntervalMs > 0) {
    timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  return {
    record(publicId, at, ip) {
      if (closed) return;
      const existing = pending.get(publicId);
      if (!existing) {
        pending.set(publicId, { publicId, lastUsedAt: at, lastUsedIp: ip, increment: 1 });
      } else {
        existing.increment += 1;
        if (at >= existing.lastUsedAt) {
          existing.lastUsedAt = at;
          existing.lastUsedIp = ip;
        }
      }
      if (pending.size >= maxPending) void flush();
    },
    flush,
    async shutdown() {
      closed = true;
      if (timer) clearInterval(timer);
      await flush();
    },
  };
}
