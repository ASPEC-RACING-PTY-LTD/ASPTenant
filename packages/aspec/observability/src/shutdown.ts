import { configError, ObservabilityError, ObservabilityErrorCodes } from './errors.js';
import type { Health } from './health.js';
import type { LoggerLike } from './ports.js';

export interface GracefulShutdownOptions {
  /** Signals that start the shutdown. Default `['SIGTERM', 'SIGINT']`. Pass `[]` to trigger manually. */
  signals?: readonly NodeJS.Signals[];
  /**
   * Time between marking the process as draining (readiness fails) and running onShutdown, so
   * load balancers stop routing new traffic. Default 5000 ms.
   */
  drainDelayMs?: number;
  /** Maximum time for onShutdown. Default 30000 ms. */
  timeoutMs?: number;
  /** Closes servers, pools and queues. Runs after the drain delay. */
  onShutdown?: (reason: string) => void | Promise<void>;
  logger?: LoggerLike & { flush?(): void };
  /** Call process.exit when done (0 on success, 1 on failure or timeout). Default true. */
  exit?: boolean;
}

export interface GracefulShutdown {
  /** Runs the shutdown sequence once; later calls return the same promise. Resolves to the exit code. */
  shutdown(reason?: string): Promise<number>;
  /** Removes the signal listeners. */
  dispose(): void;
  readonly shuttingDown: boolean;
}

function nonNegativeInt(value: number, option: string): number {
  if (!Number.isInteger(value) || value < 0)
    throw configError(option, 'must be a non-negative integer');
  return value;
}

/**
 * Wires graceful shutdown: on a signal, readiness turns false (health.drain()), the process
 * keeps serving in-flight and late-routed requests for drainDelayMs, then onShutdown runs with
 * a timeout, logs are flushed and the process exits. A second signal exits immediately.
 */
export function installGracefulShutdown(
  health: Pick<Health, 'drain'> | undefined,
  options: GracefulShutdownOptions = {},
): GracefulShutdown {
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as const);
  const drainDelayMs = nonNegativeInt(options.drainDelayMs ?? 5000, 'shutdown.drainDelayMs');
  const timeoutMs = nonNegativeInt(options.timeoutMs ?? 30_000, 'shutdown.timeoutMs');
  const exit = options.exit ?? true;
  const logger = options.logger;
  let running: Promise<number> | undefined;

  const shutdown = (reason = 'manual'): Promise<number> => {
    if (running) return running;
    running = (async () => {
      health?.drain();
      logger?.info(
        { reason, drainDelayMs },
        'shutdown started; readiness is failing while draining',
      );
      if (drainDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, drainDelayMs));
      let code = 0;
      if (options.onShutdown) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => options.onShutdown?.(reason)),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new ObservabilityError(
                      ObservabilityErrorCodes.shutdownTimeout,
                      `shutdown hooks did not finish within ${timeoutMs} ms`,
                    ),
                  ),
                timeoutMs,
              );
            }),
          ]);
        } catch (error) {
          code = 1;
          logger?.error({ err: error, reason }, 'shutdown failed');
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      if (code === 0) logger?.info({ reason }, 'shutdown complete');
      logger?.flush?.();
      dispose();
      if (exit) process.exit(code);
      return code;
    })();
    return running;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (running) {
      logger?.warn({ signal }, 'second shutdown signal received; exiting immediately');
      logger?.flush?.();
      if (exit) process.exit(1);
      return;
    }
    void shutdown(signal);
  };
  for (const s of signals) process.on(s, onSignal);

  function dispose(): void {
    for (const s of signals) process.removeListener(s, onSignal);
  }

  return {
    shutdown,
    dispose,
    get shuttingDown() {
      return running !== undefined;
    },
  };
}
