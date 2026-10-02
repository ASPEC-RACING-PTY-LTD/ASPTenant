import { ConfigError, type ConfigIssue } from './errors.js';
import { EnvField, type FieldMeta, type SourceMap } from './fields.js';
import { type LoadEnvOptions, loadEnv } from './load-env.js';

export type ConfigShape = { [key: string]: EnvField<unknown> | ConfigShape };

export type InferConfig<T> = {
  [K in keyof T]: T[K] extends EnvField<infer V>
    ? V
    : T[K] extends ConfigShape
      ? InferConfig<T[K]>
      : never;
};

export interface DefineConfigOptions extends LoadEnvOptions {
  /** Freeze the resulting object deeply. Default true. */
  freeze?: boolean;
}

export interface DefinedConfig<T extends ConfigShape> {
  /** Deep-typed, frozen configuration object. */
  readonly config: InferConfig<T>;
  /** Flat metadata for every leaf field. */
  readonly meta: FieldMeta[];
  readonly shape: T;
}

function collect(
  shape: ConfigShape,
  source: SourceMap,
  path: string[],
  values: Record<string, unknown>,
  metas: FieldMeta[],
  issues: ConfigIssue[],
): void {
  for (const [key, field] of Object.entries(shape)) {
    if (field instanceof EnvField) {
      const result = field.resolve(source);
      metas.push(result.meta);
      if (result.ok) values[key] = result.value;
      else issues.push(...result.issues);
    } else {
      const child: Record<string, unknown> = {};
      collect(field, source, [...path, key], child, metas, issues);
      values[key] = child;
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  for (const v of Object.values(value as object)) deepFreeze(v);
  return Object.freeze(value);
}

/**
 * Synchronously loads and validates configuration from process.env and dotenv files.
 * Returns a frozen deep-typed object.
 */
export function defineConfig<T extends ConfigShape>(
  shape: T,
  options: DefineConfigOptions = {},
): InferConfig<T> {
  const source = loadEnv(options);
  const values: Record<string, unknown> = {};
  const metas: FieldMeta[] = [];
  const issues: ConfigIssue[] = [];
  collect(shape, source, [], values, metas, issues);
  if (issues.length > 0) {
    throw new ConfigError('CONFIG_INVALID', 'configuration validation failed', issues);
  }
  const freeze = options.freeze ?? true;
  return (freeze ? deepFreeze(values) : values) as InferConfig<T>;
}

/** Same as defineConfig but also returns field metadata (for docs generators). */
export function defineConfigWithMeta<T extends ConfigShape>(
  shape: T,
  options: DefineConfigOptions = {},
): DefinedConfig<T> {
  const source = loadEnv(options);
  const values: Record<string, unknown> = {};
  const metas: FieldMeta[] = [];
  const issues: ConfigIssue[] = [];
  collect(shape, source, [], values, metas, issues);
  if (issues.length > 0) {
    throw new ConfigError('CONFIG_INVALID', 'configuration validation failed', issues);
  }
  const freeze = options.freeze ?? true;
  return {
    config: (freeze ? deepFreeze(values) : values) as InferConfig<T>,
    meta: metas,
    shape,
  };
}

/** Collect metadata from a shape without reading the environment. */
export function collectMeta(shape: ConfigShape): FieldMeta[] {
  const metas: FieldMeta[] = [];
  const walk = (s: ConfigShape) => {
    for (const field of Object.values(s)) {
      if (field instanceof EnvField) metas.push(field.meta());
      else walk(field);
    }
  };
  walk(shape);
  return metas;
}
