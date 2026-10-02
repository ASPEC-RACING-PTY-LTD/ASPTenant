import { registerCleanup } from './cleanup.js';
import { invalidOption } from './errors.js';

/**
 * Structural shape of Vitest's `vi` (or a compatible fake-timer API). Kept structural so the
 * module has no hard dependency on Vitest at runtime.
 */
export interface FakeTimersApi {
  useFakeTimers: (...args: never[]) => unknown;
  useRealTimers: () => unknown;
  advanceTimersByTime: (ms: number) => unknown;
  advanceTimersByTimeAsync?: (ms: number) => PromiseLike<unknown>;
  runAllTimers?: () => unknown;
  runAllTimersAsync?: () => PromiseLike<unknown>;
  runOnlyPendingTimers?: () => unknown;
  clearAllTimers?: () => unknown;
  getTimerCount?: () => number;
  setSystemTime?: (now: number | Date) => unknown;
}

export interface FakeTimersHandle {
  readonly api: FakeTimersApi;
  advance(ms: number): void;
  advanceAsync(ms: number): Promise<void>;
  runAll(): void;
  runAllAsync(): Promise<void>;
  /** Restores real timers. Idempotent. */
  restore(): void;
  [Symbol.dispose](): void;
}

function requireApi(api: FakeTimersApi | undefined): FakeTimersApi {
  if (!api || typeof api.useFakeTimers !== 'function' || typeof api.useRealTimers !== 'function') {
    throw invalidOption('api', "pass Vitest's vi (or a compatible fake-timer API)");
  }
  return api;
}

/**
 * Installs fake timers through a Vitest-compatible API and restores them on `restore()`,
 * `Symbol.dispose` or `cleanupAll()`.
 */
export function useFakeTimers(api: FakeTimersApi, config?: object): FakeTimersHandle {
  const vi = requireApi(api);
  const install = vi.useFakeTimers as (c?: object) => unknown;
  install(config);
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    unregister();
    vi.useRealTimers();
  };
  const unregister = registerCleanup(restore);
  return {
    api: vi,
    advance(ms) {
      if (!Number.isFinite(ms)) throw invalidOption('ms', 'must be a finite number');
      vi.advanceTimersByTime(ms);
    },
    async advanceAsync(ms) {
      if (!Number.isFinite(ms)) throw invalidOption('ms', 'must be a finite number');
      if (vi.advanceTimersByTimeAsync) await vi.advanceTimersByTimeAsync(ms);
      else vi.advanceTimersByTime(ms);
    },
    runAll() {
      if (!vi.runAllTimers) throw invalidOption('api', 'runAllTimers is not available');
      vi.runAllTimers();
    },
    async runAllAsync() {
      if (vi.runAllTimersAsync) await vi.runAllTimersAsync();
      else if (vi.runAllTimers) vi.runAllTimers();
      else throw invalidOption('api', 'runAllTimers is not available');
    },
    restore,
    [Symbol.dispose]: restore,
  };
}

/** Runs `fn` with fake timers installed and always restores real timers afterwards. */
export async function withFakeTimers<T>(
  api: FakeTimersApi,
  fn: (timers: FakeTimersHandle) => Promise<T> | T,
  config?: object,
): Promise<T> {
  const timers = useFakeTimers(api, config);
  try {
    return await fn(timers);
  } finally {
    timers.restore();
  }
}
