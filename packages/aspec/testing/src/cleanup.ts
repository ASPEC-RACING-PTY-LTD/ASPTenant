import { TestingError, TestingErrorCode } from './errors.js';

export type CleanupFn = () => unknown;

// Process-wide on purpose: helpers that patch globals (fetch, process.env, fake timers) or
// hold OS resources (servers, temporary directories) register here so one afterEach hook
// restores everything, whichever test runner is in use.
const registry = new Set<{ fn: CleanupFn }>();

/**
 * Registers a cleanup callback run by `cleanupAll()`. Returns a function that unregisters it
 * (call it when the resource was released manually).
 */
export function registerCleanup(fn: CleanupFn): () => void {
  const entry = { fn };
  registry.add(entry);
  return () => {
    registry.delete(entry);
  };
}

/** Number of pending cleanup callbacks (useful to assert that a test leaked nothing). */
export function pendingCleanups(): number {
  return registry.size;
}

/**
 * Runs every registered cleanup in reverse registration order. All callbacks run even if one
 * fails; failures are rethrown together as a TESTING_CLEANUP_FAILED error.
 */
export async function cleanupAll(): Promise<void> {
  const entries = [...registry].reverse();
  registry.clear();
  const errors: unknown[] = [];
  for (const entry of entries) {
    try {
      await entry.fn();
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new TestingError(
      TestingErrorCode.CLEANUP_FAILED,
      `${errors.length} cleanup callback(s) failed: ${errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')}`,
      { cause: new AggregateError(errors) },
    );
  }
}
