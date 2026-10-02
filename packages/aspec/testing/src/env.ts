import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { registerCleanup } from './cleanup.js';
import { invalidOption, TestingError, TestingErrorCode } from './errors.js';

/** Variables to apply. `undefined` deletes the variable. */
export type EnvVars = Record<string, string | undefined>;

function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out.set(k, v);
  return out;
}

function restoreSnapshot(saved: Map<string, string>): void {
  for (const key of Object.keys(process.env)) {
    if (!saved.has(key)) delete process.env[key];
  }
  for (const [key, value] of saved) {
    if (process.env[key] !== value) process.env[key] = value;
  }
}

function apply(vars: EnvVars): void {
  for (const [key, value] of Object.entries(vars)) {
    if (key === '' || key.includes('=') || key.includes('\0'))
      throw invalidOption('vars', `"${key}" is not a valid environment variable name`);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * Runs `fn` with `vars` applied to process.env and restores process.env exactly afterwards
 * (values, additions and deletions, including changes made inside `fn`). Async functions are
 * restored when their promise settles.
 */
export function withEnv<T>(vars: EnvVars, fn: () => T): T {
  const saved = snapshot();
  try {
    apply(vars);
  } catch (err) {
    restoreSnapshot(saved);
    throw err;
  }
  let result: T;
  try {
    result = fn();
  } catch (err) {
    restoreSnapshot(saved);
    throw err;
  }
  if (
    result !== null &&
    typeof result === 'object' &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    return Promise.resolve(result).finally(() => restoreSnapshot(saved)) as T;
  }
  restoreSnapshot(saved);
  return result;
}

export interface EnvIsolation {
  set(key: string, value: string): void;
  unset(key: string): void;
  /** Restores the snapshot taken when isolateEnv() was called. Idempotent. */
  restore(): void;
  [Symbol.dispose](): void;
}

/**
 * Snapshots process.env, applies `vars`, and restores the snapshot on `restore()`,
 * `Symbol.dispose` or `cleanupAll()`.
 */
export function isolateEnv(vars: EnvVars = {}): EnvIsolation {
  const saved = snapshot();
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    unregister();
    restoreSnapshot(saved);
  };
  const unregister = registerCleanup(restore);
  try {
    apply(vars);
  } catch (err) {
    restore();
    throw err;
  }
  return {
    set: (key, value) => apply({ [key]: value }),
    unset: (key) => apply({ [key]: undefined }),
    restore,
    [Symbol.dispose]: restore,
  };
}

export interface TempDir {
  readonly path: string;
  /** Resolves a path inside the directory; rejects paths that escape it. */
  resolve(...segments: string[]): string;
  writeFile(relativePath: string, content: string | Uint8Array): Promise<string>;
  readFile(relativePath: string): Promise<string>;
  mkdir(relativePath: string): Promise<string>;
  /** Removes the directory recursively. Idempotent. */
  cleanup(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface TempDirOptions {
  /** Directory name prefix (letters, digits, - and _). Default "aspec-testing". */
  prefix?: string;
  /** Parent directory. Default os.tmpdir(). */
  parent?: string;
}

/** Creates a unique temporary directory removed by `cleanup()` or `cleanupAll()`. */
export async function createTempDir(options: TempDirOptions = {}): Promise<TempDir> {
  const prefix = options.prefix ?? 'aspec-testing';
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(prefix))
    throw invalidOption('prefix', 'use 1 to 50 letters, digits, - or _');
  const root = await mkdtemp(join(options.parent ?? tmpdir(), `${prefix}-`));
  let removed: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (!removed) {
      unregister();
      removed = rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    return removed;
  };
  const unregister = registerCleanup(cleanup);
  const inside = (...segments: string[]): string => {
    const target = resolve(root, ...segments);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new TestingError(
        TestingErrorCode.PATH_OUTSIDE_ROOT,
        `Path "${segments.join('/')}" escapes the temporary directory`,
      );
    }
    return target;
  };
  return {
    path: root,
    resolve: inside,
    async writeFile(relativePath, content) {
      const target = inside(relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      return target;
    },
    readFile: (relativePath) => readFile(inside(relativePath), 'utf8'),
    async mkdir(relativePath) {
      const target = inside(relativePath);
      await mkdir(target, { recursive: true });
      return target;
    },
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}

/** Runs `fn` with a fresh temporary directory and always removes it afterwards. */
export async function withTempDir<T>(
  fn: (dir: TempDir) => Promise<T> | T,
  options: TempDirOptions = {},
): Promise<T> {
  const dir = await createTempDir(options);
  try {
    return await fn(dir);
  } finally {
    await dir.cleanup();
  }
}
