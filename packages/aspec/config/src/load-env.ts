import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export type EnvRecord = Record<string, string | undefined>;

export interface LoadEnvOptions {
  /** Working directory for dotenv files. Default process.cwd(). */
  cwd?: string;
  /** Override NODE_ENV for file selection. */
  nodeEnv?: string;
  /**
   * Real process environment. Default process.env. Wins over every dotenv file.
   */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Enable `$VAR` / `${VAR}` expansion in dotenv values. Disabled by default.
   * Expansion only substitutes already-resolved keys; recursive cycles yield empty.
   */
  expand?: boolean;
  /** Skip loading dotenv files entirely. */
  ignoreFiles?: boolean;
}

/**
 * Precedence (later wins among files; real env always wins):
 * `.env` → `.env.local` (skipped when NODE_ENV=test) → `.env.<NODE_ENV>` →
 * `.env.<NODE_ENV>.local` → process.env.
 */
export function loadEnv(options: LoadEnvOptions = {}): EnvRecord {
  const cwd = options.cwd ?? process.cwd();
  const nodeEnv =
    options.nodeEnv ?? options.processEnv?.NODE_ENV ?? process.env.NODE_ENV ?? 'development';
  const processEnv = options.processEnv ?? process.env;
  const merged: EnvRecord = {};

  if (!options.ignoreFiles) {
    const files = ['.env'];
    if (nodeEnv !== 'test') files.push('.env.local');
    files.push(`.env.${nodeEnv}`, `.env.${nodeEnv}.local`);
    for (const file of files) {
      const path = resolve(cwd, file);
      if (!existsSync(path)) continue;
      Object.assign(merged, parseEnv(readFileSync(path, 'utf8')));
    }
  }

  if (options.expand) {
    expandInPlace(merged);
  }

  for (const [k, v] of Object.entries(processEnv)) {
    if (v !== undefined) merged[k] = v;
  }
  return merged;
}

const EXPAND = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function expandInPlace(env: EnvRecord): void {
  const resolving = new Set<string>();
  const resolveKey = (key: string): string => {
    if (resolving.has(key)) return '';
    resolving.add(key);
    const raw = env[key] ?? '';
    const out = raw.replace(EXPAND, (_m, a: string, b: string) => resolveKey(a || b));
    resolving.delete(key);
    env[key] = out;
    return out;
  };
  for (const key of Object.keys(env)) resolveKey(key);
}
