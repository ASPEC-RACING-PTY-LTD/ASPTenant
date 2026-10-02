import type { LoggerLike } from '../src/ports.js';
import type { RateLimitStore } from '../src/store.js';

export interface FakeClock {
  t: number;
  now(): number;
  advance(ms: number): void;
}

export function fakeClock(start = 1_000_000_000_000): FakeClock {
  return {
    t: start,
    now() {
      return this.t;
    },
    advance(ms: number) {
      this.t += ms;
    },
  };
}

export interface RecordingLogger extends LoggerLike {
  entries: { level: string; obj: Record<string, unknown>; msg: string | undefined }[];
}

export function recordingLogger(): RecordingLogger {
  const entries: RecordingLogger['entries'] = [];
  const log =
    (level: string) =>
    (obj: Record<string, unknown>, msg?: string): void => {
      entries.push({ level, obj, msg });
    };
  return {
    entries,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
}

/** Store whose every call fails (or hangs), to exercise failure modes. */
export function failingStore(mode: 'reject' | 'hang' = 'reject'): RateLimitStore & {
  calls: number;
} {
  const fail = <T>(): Promise<T> => {
    store.calls++;
    if (mode === 'hang') return new Promise<T>(() => {});
    return Promise.reject(new Error('connection refused'));
  };
  const store = {
    calls: 0,
    apply: () => fail(),
    reset: () => fail(),
    recordViolation: () => fail(),
    getBan: () => fail(),
    setBan: () => fail(),
    clearBan: () => fail(),
  } as RateLimitStore & { calls: number };
  return store;
}
