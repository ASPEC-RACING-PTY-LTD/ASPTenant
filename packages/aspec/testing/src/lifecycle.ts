import { TestingError, TestingErrorCode } from './errors.js';

type Hook = (fn: () => unknown) => unknown;

/**
 * Lifecycle hooks of any runner. Pass Vitest's `{ beforeAll, afterAll, beforeEach, afterEach }`
 * or node:test's `{ before, after, beforeEach, afterEach }`.
 */
export interface LifecycleHooks {
  beforeAll?: Hook;
  afterAll?: Hook;
  before?: Hook;
  after?: Hook;
  beforeEach?: Hook;
  afterEach?: Hook;
}

export interface FixtureDefinition<T> {
  setup: () => Promise<T> | T;
  teardown?: (value: T) => Promise<void> | void;
  /** "file": once per test file (beforeAll/afterAll). "test": fresh value per test. Default "file". */
  scope?: 'file' | 'test';
}

export interface FixtureHandle<T> {
  /** The current value; throws TESTING_FIXTURE_NOT_ACTIVE outside the fixture's lifetime. */
  readonly value: T;
  readonly active: boolean;
}

function pick(
  hooks: LifecycleHooks,
  primary: keyof LifecycleHooks,
  fallback: keyof LifecycleHooks,
): Hook {
  const hook = hooks[primary] ?? hooks[fallback];
  if (!hook)
    throw new TestingError(
      TestingErrorCode.INVALID_OPTION,
      `Invalid option "hooks": missing ${primary} (or ${fallback})`,
    );
  return hook;
}

/** Registers a fixture with a runner's lifecycle hooks, independent of the runner. */
export function useFixture<T>(
  hooks: LifecycleHooks,
  definition: FixtureDefinition<T>,
): FixtureHandle<T> {
  const scope = definition.scope ?? 'file';
  let current: { value: T } | undefined;
  const start = async (): Promise<void> => {
    current = { value: await definition.setup() };
  };
  const stop = async (): Promise<void> => {
    const held = current;
    current = undefined;
    if (held && definition.teardown) await definition.teardown(held.value);
  };
  if (scope === 'file') {
    pick(hooks, 'beforeAll', 'before')(start);
    pick(hooks, 'afterAll', 'after')(stop);
  } else {
    pick(hooks, 'beforeEach', 'beforeEach')(start);
    pick(hooks, 'afterEach', 'afterEach')(stop);
  }
  return {
    get value(): T {
      if (!current)
        throw new TestingError(
          TestingErrorCode.FIXTURE_NOT_ACTIVE,
          'Fixture value accessed outside its lifecycle (before setup or after teardown)',
        );
      return current.value;
    },
    get active() {
      return current !== undefined;
    },
  };
}
