import { AuditError } from '../errors.js';
import type { LoggerLike } from '../ports.js';
import type { AuditEventSink } from '../store.js';
import type { AuditEvent } from '../types.js';

export type OverflowPolicy = 'block' | 'drop-newest' | 'drop-oldest' | 'error';

export type DropReason = 'overflow' | 'write-failed' | 'closed';

export interface BufferedSinkOptions {
  /** Maximum queued events. Default 10000. */
  maxQueue?: number;
  /** Events per write to the inner sink. Default 100. */
  batchSize?: number;
  /** Background flush interval. Default 1000 ms. */
  flushIntervalMs?: number;
  /**
   * What happens when the queue is full:
   * `block` (default) waits for space (up to blockTimeoutMs, then AUDIT_QUEUE_FULL),
   * `drop-newest` discards the incoming events, `drop-oldest` discards the oldest queued
   * events, `error` rejects with AUDIT_QUEUE_FULL.
   */
  overflow?: OverflowPolicy;
  /** Default 5000 ms. */
  blockTimeoutMs?: number;
  /** Attempts after the first failed write of a batch. Default 3. */
  maxRetries?: number;
  /** Delay before the first retry, doubled for each further retry. Default 200 ms. */
  retryDelayMs?: number;
  /** Called with events that were discarded. */
  onDrop?: (events: readonly AuditEvent[], reason: DropReason) => void;
  logger?: LoggerLike;
  /** Flush when the process is about to exit (beforeExit). Default true. */
  flushOnExit?: boolean;
}

export interface BufferedSink extends AuditEventSink {
  /** Events waiting to be written. */
  pending(): number;
  /** Events discarded so far. */
  dropped(): number;
  flush(): Promise<void>;
  close(): Promise<void>;
}

function positive(name: string, v: number, min = 1): number {
  if (!Number.isInteger(v) || v < min) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', `${name} must be an integer of at least ${min}`);
  }
  return v;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wraps a sink with a bounded in-memory queue so recording does not wait for slow storage.
 * Events still queued when the process crashes are lost; call close() on shutdown.
 */
export function createBufferedSink(
  inner: AuditEventSink,
  options: BufferedSinkOptions = {},
): BufferedSink {
  const maxQueue = positive('maxQueue', options.maxQueue ?? 10000);
  const batchSize = positive('batchSize', options.batchSize ?? 100);
  const flushIntervalMs = positive('flushIntervalMs', options.flushIntervalMs ?? 1000);
  const blockTimeoutMs = positive('blockTimeoutMs', options.blockTimeoutMs ?? 5000);
  const maxRetries = positive('maxRetries', options.maxRetries ?? 3, 0);
  const retryDelayMs = positive('retryDelayMs', options.retryDelayMs ?? 200, 0);
  const overflow = options.overflow ?? 'block';
  if (!['block', 'drop-newest', 'drop-oldest', 'error'].includes(overflow)) {
    throw new AuditError(
      'AUDIT_INVALID_OPTIONS',
      'overflow must be block, drop-newest, drop-oldest or error',
    );
  }

  const queue: AuditEvent[] = [];
  let droppedCount = 0;
  let reserved = 0;
  let closed = false;
  let draining: Promise<void> | undefined;
  const spaceWaiters: (() => void)[] = [];

  const drop = (events: readonly AuditEvent[], reason: DropReason) => {
    if (events.length === 0) return;
    droppedCount += events.length;
    options.logger?.warn({ count: events.length, reason }, 'audit events dropped');
    try {
      options.onDrop?.(events, reason);
    } catch {
      // A failing drop callback must not break the queue.
    }
  };

  const wakeWaiters = () => {
    for (const waiter of spaceWaiters.splice(0)) waiter();
  };

  const writeWithRetry = async (batch: AuditEvent[]): Promise<void> => {
    let attempt = 0;
    for (;;) {
      try {
        await inner.write(batch);
        return;
      } catch (err) {
        if (attempt >= maxRetries) {
          options.logger?.error(
            { err: err instanceof Error ? err.message : String(err), count: batch.length },
            'audit buffered write failed',
          );
          drop(batch, 'write-failed');
          return;
        }
        await sleep(retryDelayMs * 2 ** attempt);
        attempt++;
      }
    }
  };

  const drain = (): Promise<void> => {
    draining ??= (async () => {
      try {
        while (queue.length > 0) {
          const batch = queue.splice(0, batchSize);
          wakeWaiters();
          await writeWithRetry(batch);
        }
      } finally {
        draining = undefined;
      }
    })();
    return draining;
  };

  const timer = setInterval(() => {
    if (queue.length > 0) void drain();
  }, flushIntervalMs);
  timer.unref?.();

  const onBeforeExit = () => {
    void drain();
  };
  if (options.flushOnExit ?? true) process.on('beforeExit', onBeforeExit);

  const waitForSpace = (needed: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = spaceWaiters.indexOf(check);
        if (idx >= 0) spaceWaiters.splice(idx, 1);
        reject(
          new AuditError('AUDIT_QUEUE_FULL', `audit queue stayed full for ${blockTimeoutMs} ms`),
        );
      }, blockTimeoutMs);
      function check() {
        if (queue.length + reserved + needed <= maxQueue) {
          reserved += needed;
          clearTimeout(t);
          resolve();
        } else {
          spaceWaiters.push(check);
        }
      }
      spaceWaiters.push(check);
      void drain();
    });

  const sink: BufferedSink = {
    name: `buffered(${inner.name ?? 'sink'})`,
    async write(events) {
      if (closed) throw new AuditError('AUDIT_SINK_CLOSED', 'the buffered audit sink is closed');
      let incoming = [...events];
      if (queue.length + reserved + incoming.length > maxQueue) {
        switch (overflow) {
          case 'error':
            throw new AuditError('AUDIT_QUEUE_FULL', `audit queue is full (${maxQueue} events)`);
          case 'drop-newest': {
            const room = Math.max(0, maxQueue - queue.length - reserved);
            drop(incoming.slice(room), 'overflow');
            incoming = incoming.slice(0, room);
            break;
          }
          case 'drop-oldest': {
            const excess = queue.length + incoming.length - maxQueue;
            drop(queue.splice(0, Math.min(excess, queue.length)), 'overflow');
            if (incoming.length > maxQueue) {
              drop(incoming.slice(0, incoming.length - maxQueue), 'overflow');
              incoming = incoming.slice(incoming.length - maxQueue);
            }
            break;
          }
          case 'block': {
            const needed = Math.min(incoming.length, maxQueue);
            await waitForSpace(needed);
            reserved -= needed;
            if (incoming.length > maxQueue) {
              drop(incoming.slice(0, incoming.length - maxQueue), 'overflow');
              incoming = incoming.slice(incoming.length - maxQueue);
            }
            if (closed)
              throw new AuditError('AUDIT_SINK_CLOSED', 'the buffered audit sink is closed');
            break;
          }
        }
      }
      queue.push(...incoming);
      if (queue.length >= batchSize) void drain();
    },
    async flush() {
      while (queue.length > 0 || draining) await drain();
      await inner.flush?.();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      process.off('beforeExit', onBeforeExit);
      while (queue.length > 0 || draining) await drain();
      await inner.flush?.();
      await inner.close?.();
    },
    pending: () => queue.length,
    dropped: () => droppedCount,
  };
  if (inner.recoverHeads) {
    const recover = inner.recoverHeads.bind(inner);
    sink.recoverHeads = recover;
  }
  return sink;
}
