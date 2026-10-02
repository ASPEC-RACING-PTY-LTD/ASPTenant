import { invalidOption, TestingError, TestingErrorCode } from './errors.js';
import { createRandom, getSeed, type Random } from './random.js';

/** Persists built records for `create` and `createList`. */
export interface PersistenceAdapter<T> {
  /** Stores the record and returns the persisted version (for example with generated columns). */
  insert(record: T, meta: { factory: string }): Promise<T>;
}

export interface FactoryContext {
  /** 1-based sequence number of this build within the factory (reset by resetSequences()). */
  readonly sequence: number;
  /** Deterministic generator seeded from the global seed, the factory name and the sequence. */
  readonly random: Random;
  /** "build" for build/buildList, "create" for create/createList. */
  readonly mode: 'build' | 'create';
  /**
   * Declares an associated record. It is built (or created, in create mode, before this record)
   * only if the field is not overridden. `select` maps the associated record to the field value.
   */
  association<A, V = A>(factory: Factory<A>, options?: AssociationOptions<A, V>): V;
}

export interface AssociationOptions<A, V> {
  overrides?: Partial<A>;
  traits?: readonly string[];
  select?: (record: A) => V;
}

export type Trait<T> = Partial<T> | ((ctx: FactoryContext) => Partial<T>);
export type Overrides<T> = Partial<T> | ((ctx: FactoryContext) => Partial<T>);

export interface FactoryOptions<T> {
  /** Name used for seeding and error messages. Default `factory<N>` in definition order. */
  name?: string;
  traits?: Record<string, Trait<T>>;
  /** Adapter used by create/createList unless one is passed per call. */
  adapter?: PersistenceAdapter<T>;
  /** Runs after every build (also before persistence in create mode). */
  afterBuild?: (record: T, ctx: FactoryContext) => T | undefined;
  /** Runs after a record was persisted. */
  afterCreate?: (record: T, ctx: FactoryContext) => T | undefined | Promise<T | undefined>;
}

export interface BuildOptions<T> {
  traits?: readonly string[];
  adapter?: PersistenceAdapter<T>;
}

export interface Factory<T> {
  readonly name: string;
  build(overrides?: Overrides<T>, options?: BuildOptions<T>): T;
  buildList(count: number, overrides?: Overrides<T>, options?: BuildOptions<T>): T[];
  create(overrides?: Overrides<T>, options?: BuildOptions<T>): Promise<T>;
  createList(count: number, overrides?: Overrides<T>, options?: BuildOptions<T>): Promise<T[]>;
  /** Returns a factory view that always applies these traits first. */
  withTraits(...traits: string[]): Factory<T>;
  /** Returns a factory view that persists through `adapter`. */
  withAdapter(adapter: PersistenceAdapter<T>): Factory<T>;
  /** Resets this factory's sequence to 0. */
  resetSequence(): void;
}

export interface Sequence<V> {
  next(): V;
  peek(): number;
  reset(): void;
}

const ASSOCIATION = Symbol('aspec.testing.association');

interface AssociationMarker {
  [ASSOCIATION]: true;
  factory: Factory<unknown>;
  options: AssociationOptions<unknown, unknown>;
}

function isMarker(value: unknown): value is AssociationMarker {
  return typeof value === 'object' && value !== null && ASSOCIATION in value;
}

interface Resettable {
  reset(): void;
}

// Sequences are process-wide so resetSequences() can restore reproducibility between tests.
const resettables = new Set<Resettable>();
let anonymousFactories = 0;
const MAX_LIST = 100_000;

/** Resets every factory and standalone sequence to its initial state. */
export function resetSequences(): void {
  for (const r of resettables) r.reset();
}

/** Standalone sequence: `createSequence((n) => \`user${n}@example.test\`)`. */
export function createSequence<V = number>(format?: (n: number) => V): Sequence<V> {
  let n = 0;
  const seq: Sequence<V> = {
    next: () => {
      n += 1;
      return format ? format(n) : (n as V);
    },
    peek: () => n,
    reset: () => {
      n = 0;
    },
  };
  resettables.add(seq);
  return seq;
}

function checkCount(count: number): void {
  if (!Number.isInteger(count) || count < 0 || count > MAX_LIST) {
    throw invalidOption('count', `must be an integer between 0 and ${MAX_LIST}`);
  }
}

/**
 * Defines a test data factory.
 *
 * ```ts
 * const users = defineFactory<User>((ctx) => ({ id: ctx.random.uuid(), email: ctx.random.email(), role: 'member' }), {
 *   name: 'user',
 *   traits: { admin: { role: 'admin' } },
 * });
 * users.build({ email: 'ada@example.test' }, { traits: ['admin'] });
 * ```
 */
export function defineFactory<T>(
  builder: (ctx: FactoryContext) => T,
  options: FactoryOptions<T> = {},
): Factory<T> {
  anonymousFactories += 1;
  const name = options.name ?? `factory${anonymousFactories}`;
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(name))
    throw invalidOption('name', 'use 1 to 100 letters, digits, _ . : or -');
  const traits = options.traits ?? {};
  const state = {
    sequence: 0,
    reset() {
      this.sequence = 0;
    },
  };
  resettables.add(state);

  const makeContext = (mode: 'build' | 'create'): FactoryContext => {
    state.sequence += 1;
    const sequence = state.sequence;
    return {
      sequence,
      mode,
      random: createRandom(`${getSeed()}:${name}:${sequence}`),
      association<A, V = A>(factory: Factory<A>, opts: AssociationOptions<A, V> = {}): V {
        const marker: AssociationMarker = {
          [ASSOCIATION]: true,
          factory: factory as Factory<unknown>,
          options: opts as AssociationOptions<unknown, unknown>,
        };
        // The marker is resolved before the record is returned, so the declared type holds.
        return marker as unknown as V;
      },
    };
  };

  const assemble = (
    ctx: FactoryContext,
    overrides: Overrides<T> | undefined,
    traitNames: readonly string[],
  ): Record<string, unknown> => {
    const base = builder(ctx);
    if (base === null || typeof base !== 'object') {
      throw invalidOption('builder', `factory "${name}" must return an object`);
    }
    let record: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const traitName of traitNames) {
      const trait = traits[traitName];
      if (trait === undefined) {
        throw new TestingError(
          TestingErrorCode.FACTORY_UNKNOWN_TRAIT,
          `Factory "${name}" has no trait "${traitName}". Known traits: ${Object.keys(traits).join(', ') || '(none)'}`,
        );
      }
      record = { ...record, ...(typeof trait === 'function' ? trait(ctx) : trait) };
    }
    if (overrides !== undefined) {
      record = { ...record, ...(typeof overrides === 'function' ? overrides(ctx) : overrides) };
    }
    return record;
  };

  const resolveSync = (record: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(record)) {
      if (!isMarker(value)) continue;
      const assoc = value.factory.build(value.options.overrides, traitOpts(value.options.traits));
      record[key] = value.options.select ? value.options.select(assoc) : assoc;
    }
  };

  const resolveAsync = async (record: Record<string, unknown>): Promise<void> => {
    for (const [key, value] of Object.entries(record)) {
      if (!isMarker(value)) continue;
      const assoc = await value.factory.create(
        value.options.overrides,
        traitOpts(value.options.traits),
      );
      record[key] = value.options.select ? value.options.select(assoc) : assoc;
    }
  };

  const make = (
    baseTraits: readonly string[],
    baseAdapter: PersistenceAdapter<T> | undefined,
  ): Factory<T> => {
    const allTraits = (opts?: BuildOptions<T>): readonly string[] => [
      ...baseTraits,
      ...(opts?.traits ?? []),
    ];
    const build = (overrides?: Overrides<T>, opts?: BuildOptions<T>): T => {
      const ctx = makeContext('build');
      const record = assemble(ctx, overrides, allTraits(opts));
      resolveSync(record);
      const out = record as T;
      return options.afterBuild ? (options.afterBuild(out, ctx) ?? out) : out;
    };
    const create = async (overrides?: Overrides<T>, opts?: BuildOptions<T>): Promise<T> => {
      const adapter = opts?.adapter ?? baseAdapter;
      if (!adapter) {
        throw new TestingError(
          TestingErrorCode.FACTORY_NO_ADAPTER,
          `Factory "${name}" has no persistence adapter. Pass { adapter } to defineFactory, withAdapter() or create().`,
        );
      }
      const ctx = makeContext('create');
      const record = assemble(ctx, overrides, allTraits(opts));
      await resolveAsync(record);
      let out = record as T;
      if (options.afterBuild) out = options.afterBuild(out, ctx) ?? out;
      out = await adapter.insert(out, { factory: name });
      if (options.afterCreate) out = (await options.afterCreate(out, ctx)) ?? out;
      return out;
    };
    return {
      name,
      build,
      buildList(count, overrides, opts) {
        checkCount(count);
        return Array.from({ length: count }, () => build(overrides, opts));
      },
      create,
      async createList(count, overrides, opts) {
        checkCount(count);
        const out: T[] = [];
        for (let i = 0; i < count; i++) out.push(await create(overrides, opts));
        return out;
      },
      withTraits: (...more) => make([...baseTraits, ...more], baseAdapter),
      withAdapter: (adapter) => make(baseTraits, adapter),
      resetSequence: () => state.reset(),
    };
  };

  return make([], options.adapter);
}

function traitOpts<A>(traits: readonly string[] | undefined): BuildOptions<A> | undefined {
  return traits ? { traits } : undefined;
}

/** In-memory persistence adapter; records are kept in insertion order. */
export interface MemoryPersistence<T> extends PersistenceAdapter<T> {
  readonly records: readonly T[];
  clear(): void;
}

export function memoryPersistence<T>(options: { maxRecords?: number } = {}): MemoryPersistence<T> {
  const max = options.maxRecords ?? MAX_LIST;
  const records: T[] = [];
  return {
    records,
    async insert(record) {
      if (records.length >= max)
        throw invalidOption('maxRecords', `memory persistence is capped at ${max} records`);
      const copy = structuredClone(record);
      records.push(copy);
      return copy;
    },
    clear() {
      records.length = 0;
    },
  };
}
