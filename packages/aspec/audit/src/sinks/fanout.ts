import { AuditError } from '../errors.js';
import type { LoggerLike } from '../ports.js';
import type { AuditEventSink } from '../store.js';
import type { ChainHead } from '../types.js';

export interface FanoutSinkOptions {
  /**
   * `all` (default): the write fails when any sink fails (after every sink was attempted).
   * `any`: the write succeeds when at least one sink accepted the events; failures are logged.
   */
  mode?: 'all' | 'any';
  logger?: LoggerLike;
}

/** Writes every batch to several sinks concurrently. */
export function createFanoutSink(
  sinks: readonly AuditEventSink[],
  options: FanoutSinkOptions = {},
): AuditEventSink {
  if (sinks.length === 0) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'createFanoutSink needs at least one sink');
  }
  const mode = options.mode ?? 'all';
  if (mode !== 'all' && mode !== 'any') {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'fanout mode must be all or any');
  }
  const list = [...sinks];
  return {
    name: `fanout(${list.map((s) => s.name ?? 'sink').join(',')})`,
    async write(events) {
      const results = await Promise.allSettled(list.map((s) => s.write(events)));
      const failed = results.flatMap((r, i) =>
        r.status === 'rejected' ? [{ i, reason: r.reason }] : [],
      );
      for (const f of failed) {
        options.logger?.error(
          {
            sink: list[f.i]?.name ?? `sink ${f.i}`,
            err: f.reason instanceof Error ? f.reason.message : String(f.reason),
          },
          'audit fanout sink failed',
        );
      }
      if (failed.length > 0 && (mode === 'all' || failed.length === list.length)) {
        throw new AuditError(
          'AUDIT_SINK_FAILED',
          `${failed.length} of ${list.length} audit sinks failed`,
          { cause: new AggregateError(failed.map((f) => f.reason)) },
        );
      }
    },
    async flush() {
      await Promise.all(list.map((s) => s.flush?.()));
    },
    async close() {
      await Promise.all(list.map((s) => s.close?.()));
    },
    async recoverHeads() {
      const heads = new Map<string, ChainHead>();
      for (const s of list) {
        for (const h of (await s.recoverHeads?.()) ?? []) {
          const cur = heads.get(h.stream);
          if (!cur || h.seq > cur.seq) heads.set(h.stream, h);
        }
      }
      return [...heads.values()];
    },
  };
}
